import CarPlay
import Foundation
import UIKit

final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var controller: CarPlayLibraryController?

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        let controller = CarPlayLibraryController(interfaceController: interfaceController)
        self.controller = controller
        controller.start()
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        controller?.stop()
        controller = nil
    }
}

final class CarPlayLibraryController: NSObject, CPNowPlayingTemplateObserver, CPInterfaceControllerDelegate {
    private let interfaceController: CPInterfaceController
    private let coordinator = CarPlayCoordinator.shared
    private var isShowingNowPlaying = false

    private lazy var listeningTemplate = makeListTemplate(
        title: "Listening",
        symbol: "headphones",
        emptyTitle: "Nothing started yet",
        emptySubtitle: "Books you are part-way through appear here."
    )
    private lazy var downloadedTemplate = makeListTemplate(
        title: "Downloaded",
        symbol: "arrow.down.circle",
        emptyTitle: "No downloads",
        emptySubtitle: "Download books in OperaLibre to listen without your server."
    )
    private lazy var libraryTemplate = makeListTemplate(
        title: "Library",
        symbol: "books.vertical",
        emptyTitle: "No books yet",
        emptySubtitle: "Open OperaLibre on your phone to sync your library."
    )

    init(interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        super.init()
    }

    func start() {
        coordinator.carSceneDidConnect()
        coordinator.onPlaybackChange = { [weak self] in
            DispatchQueue.main.async { self?.refresh() }
        }
        coordinator.onPlaybackFailure = { [weak self] message in
            DispatchQueue.main.async { self?.presentFailure(message) }
        }
        coordinator.onLibraryChange = { [weak self] in
            DispatchQueue.main.async { self?.refresh() }
        }
        interfaceController.delegate = self
        CPNowPlayingTemplate.shared.add(self)
        configureNowPlayingButtons()

        let tabBar = CPTabBarTemplate(templates: [listeningTemplate, downloadedTemplate, libraryTemplate])
        interfaceController.setRootTemplate(tabBar, animated: false) { _, _ in }
        refresh()
    }

    func stop() {
        CPNowPlayingTemplate.shared.remove(self)
        coordinator.carSceneDidDisconnect()
    }

    // MARK: - Content

    private func refresh() {
        let snapshot = coordinator.snapshot
        let playingBookId = coordinator.currentBook()?.id
        let listening = snapshot.books
            .filter { $0.isInProgress }
            .sorted { ($0.percentComplete ?? 0) > ($1.percentComplete ?? 0) }
        let downloaded = snapshot.books.filter { $0.downloaded }
        listeningTemplate.updateSections(sections(for: listening, playingBookId: playingBookId))
        downloadedTemplate.updateSections(sections(for: downloaded, playingBookId: playingBookId))
        libraryTemplate.updateSections(
            snapshot.libraryGroups(maximumItemCount: CPListTemplate.maximumItemCount)
                .compactMap { section($0.0, $0.1, playingBookId) }
        )
    }

    private func section(
        _ header: String,
        _ books: [CarLibraryBook],
        _ playingBookId: String?
    ) -> CPListSection? {
        guard !books.isEmpty else { return nil }
        return CPListSection(
            items: books.prefix(CPListTemplate.maximumItemCount).map {
                listItem(for: $0, isPlaying: $0.id == playingBookId)
            },
            header: header,
            sectionIndexTitle: nil
        )
    }

    private func sections(for books: [CarLibraryBook], playingBookId: String?) -> [CPListSection] {
        guard !books.isEmpty else { return [] }
        let items = books.prefix(CPListTemplate.maximumItemCount).map { book in
            listItem(for: book, isPlaying: book.id == playingBookId)
        }
        return [CPListSection(items: Array(items))]
    }

    private func listItem(for book: CarLibraryBook, isPlaying: Bool) -> CPListItem {
        let item = CPListItem(
            text: book.title,
            detailText: book.carSubtitle,
            image: CarLibraryStore.shared.artwork(for: book),
            accessoryImage: nil,
            accessoryType: book.downloaded ? .none : .cloud
        )
        item.userInfo = book.id
        item.isPlaying = isPlaying
        item.playingIndicatorLocation = .trailing
        if let percent = book.percentComplete {
            item.playbackProgress = percent
        }
        item.handler = { [weak self] _, completion in
            self?.select(book: book)
            completion()
        }
        return item
    }

    // MARK: - Selection

    private func select(book: CarLibraryBook) {
        if coordinator.currentBook()?.id == book.id {
            coordinator.resume()
            showNowPlaying()
            return
        }
        guard coordinator.play(book: book, atBookPosition: nil) else {
            presentFailure("This book has no playable files on this phone.")
            return
        }
        showNowPlaying()
    }

    private func showNowPlaying() {
        refresh()
        guard !isShowingNowPlaying else { return }
        isShowingNowPlaying = true
        interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true) { [weak self] success, _ in
            if !success { self?.isShowingNowPlaying = false }
        }
    }

    func templateDidDisappear(_ aTemplate: CPTemplate, animated: Bool) {
        if aTemplate === CPNowPlayingTemplate.shared { isShowingNowPlaying = false }
    }

    func templateDidAppear(_ aTemplate: CPTemplate, animated: Bool) {
        if aTemplate === CPNowPlayingTemplate.shared { isShowingNowPlaying = true }
    }

    private func configureNowPlayingButtons(rate: Double? = nil) {
        let template = CPNowPlayingTemplate.shared
        template.updateNowPlayingButtons([speedButton(rate: rate ?? coordinator.playbackRate)])
        template.isUpNextButtonEnabled = true
        template.upNextTitle = "Chapters"
    }

    private func speedButton(rate: Double) -> CPNowPlayingButton {
        CPNowPlayingImageButton(image: speedImage(for: rate)) { [weak self] _ in
            guard let self else { return }
            self.configureNowPlayingButtons(rate: self.coordinator.advancePlaybackRate())
        }
    }

    private func speedImage(for rate: Double) -> UIImage {
        let label = rate == rate.rounded()
            ? String(format: "%.0f×", rate)
            : String(format: "%g×", rate)
        let base = UIFont.systemFont(ofSize: 17, weight: .semibold)
        let font = base.fontDescriptor.withDesign(.serif).map { UIFont(descriptor: $0, size: 17) } ?? base
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.black
        ]
        let size = CPNowPlayingButtonMaximumImageSize
        let textSize = (label as NSString).size(withAttributes: attributes)
        return UIGraphicsImageRenderer(size: size).image { _ in
            (label as NSString).draw(
                at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2),
                withAttributes: attributes
            )
        }
    }

    func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
        guard let book = coordinator.currentBook(), !book.chapters.isEmpty else { return }
        let items = book.chapters.prefix(CPListTemplate.maximumItemCount).map { chapter -> CPListItem in
            let item = CPListItem(text: chapter.title, detailText: carTimestampLabel(seconds: chapter.startSeconds))
            item.handler = { [weak self] _, completion in
                self?.coordinator.seek(book, toBookPosition: chapter.startSeconds)
                self?.interfaceController.popTemplate(animated: true) { _, _ in }
                completion()
            }
            return item
        }
        let template = CPListTemplate(title: "Chapters", sections: [CPListSection(items: Array(items))])
        interfaceController.pushTemplate(template, animated: true) { _, _ in }
    }

    // MARK: - Failures

    private func presentFailure(_ message: String) {
        let alert = CPAlertTemplate(
            titleVariants: [message],
            actions: [CPAlertAction(title: "OK", style: .cancel) { [weak self] _ in
                self?.interfaceController.dismissTemplate(animated: true) { _, _ in }
            }]
        )
        interfaceController.presentTemplate(alert, animated: true) { _, _ in }
    }

    private func makeListTemplate(
        title: String,
        symbol: String,
        emptyTitle: String,
        emptySubtitle: String
    ) -> CPListTemplate {
        let template = CPListTemplate(title: title, sections: [])
        template.tabImage = UIImage(
            systemName: symbol,
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .light)
        )
        template.tabTitle = title
        template.emptyViewTitleVariants = [emptyTitle]
        template.emptyViewSubtitleVariants = [emptySubtitle]
        return template
    }
}
