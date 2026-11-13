use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! { static ALLOCATED: Cell<Option<usize>> = const { Cell::new(None) }; }
struct TrackingAllocator;
#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;
fn record(size: usize) {
    let _ = ALLOCATED.try_with(|count| {
        if let Some(bytes) = count.get() {
            count.set(Some(bytes.saturating_add(size)));
        }
    });
}
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}
pub(crate) fn allocated_bytes<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            let _ = ALLOCATED.try_with(|count| count.set(None));
        }
    }
    ALLOCATED.with(|count| {
        assert!(count.get().is_none(), "allocation measurements cannot nest");
        count.set(Some(0));
    });
    let reset = Reset;
    let result = operation();
    let bytes = ALLOCATED.with(|count| count.get().unwrap());
    drop(reset);
    (result, bytes)
}
