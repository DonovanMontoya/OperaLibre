/** The getItem/setItem half of Storage in memory, optionally holding one saved value. */
export function memoryStorage(key?: string, initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (key !== undefined && initialValue !== null) values.set(key, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}
