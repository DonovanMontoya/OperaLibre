import Foundation
import Capacitor

fileprivate struct BackgroundDownloadFile {
    let source: URL
    let destination: URL
    let label: String
    let required: Bool
}

private struct StoredBackgroundTask: Codable {
    let jobId: String
    let source: String?
    let destination: String
    let label: String
    let required: Bool
}

private struct StoredBackgroundJob: Codable {
    var title: String
    var state: String
    var total: Int
    var requiredTotal: Int
    var completed: Int
    var completedRequired: Int
    var handledTaskIds: [Int]
    var errors: [String]
    var enqueuedAt: Double?
    var files: [StoredBackgroundTask]?
}

final class BackgroundDownloadManager: NSObject, URLSessionDownloadDelegate {
    static let shared = BackgroundDownloadManager()
    static let sessionIdentifier = "com.operalibre.mobile.offline-downloads"

    private let jobsKey = "operalibre.background-download-jobs"
    private let lock = NSLock()
    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "OperaLibre background downloads"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var completionHandler: (() -> Void)?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = true
        configuration.timeoutIntervalForRequest = 600
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        configuration.httpMaximumConnectionsPerHost = 2
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    func prepare() {
        _ = session
        recoverAndStartNextJob()
    }

    fileprivate func enqueue(jobId: String, title: String, files: [BackgroundDownloadFile]) throws {
        guard !files.isEmpty else { throw DownloadError.invalidFiles }
        let descriptions = files.map { file in
            StoredBackgroundTask(
                jobId: jobId,
                source: file.source.absoluteString,
                destination: file.destination.absoluteString,
                label: file.label,
                required: file.required
            )
        }
        let existingDestinations = Set(descriptions.compactMap { info -> String? in
            guard let destination = URL(string: info.destination), destination.isFileURL else { return nil }
            return FileManager.default.fileExists(atPath: destination.path) ? info.destination : nil
        })
        let requiredTotal = descriptions.filter(\.required).count
        let completedRequired = descriptions.filter {
            $0.required && existingDestinations.contains($0.destination)
        }.count
        let enqueueResult = mutateJobs { jobs -> (createTasks: Bool, shouldStart: Bool, completed: Bool) in
            if var existing = jobs[jobId], existing.state == "running" || existing.state == "queued" {
                existing.files = descriptions
                existing.enqueuedAt = existing.enqueuedAt ?? Date().timeIntervalSince1970
                reconcileFiles(in: &existing)
                jobs[jobId] = existing
                return (false, false, existing.state == "completed")
            }
            let shouldStart = !jobs.values.contains { $0.state == "running" }
            let alreadyComplete = requiredTotal == 0 || completedRequired >= requiredTotal
            jobs[jobId] = StoredBackgroundJob(
                title: title,
                state: alreadyComplete ? "completed" : shouldStart ? "running" : "queued",
                total: files.count,
                requiredTotal: requiredTotal,
                completed: existingDestinations.count,
                completedRequired: completedRequired,
                handledTaskIds: [],
                errors: [],
                enqueuedAt: Date().timeIntervalSince1970,
                files: descriptions
            )
            return (!alreadyComplete, shouldStart, alreadyComplete)
        }
        if !enqueueResult.createTasks {
            if enqueueResult.completed { recoverAndStartNextJob() }
            return
        }

        for (file, description) in zip(files, descriptions) {
            if existingDestinations.contains(description.destination) { continue }
            try FileManager.default.createDirectory(
                at: file.destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let task = session.downloadTask(with: file.source)
            task.taskDescription = String(data: try JSONEncoder().encode(description), encoding: .utf8)
            task.priority = file.required ? URLSessionTask.highPriority : URLSessionTask.lowPriority
            if enqueueResult.shouldStart {
                task.resume()
            }
        }
        // Close the small window between persisting a job and registering its
        // URLSession tasks, and start it if the previous queue head finished
        // while those tasks were being created.
        recoverAndStartNextJob()
    }

    func status(jobId: String, completion: @escaping (Result<(String, Double, String?), Error>) -> Void) {
        session.getAllTasks { tasks in
            var shouldRecover = false
            let jobTasks = tasks.filter { self.taskInfo($0)?.jobId == jobId }
            guard let job = self.mutateJobs({ jobs -> StoredBackgroundJob? in
                guard var job = jobs[jobId] else { return nil }
                if job.files?.isEmpty != false {
                    let recoveredFiles = jobTasks.compactMap(self.taskInfo)
                    if !recoveredFiles.isEmpty { job.files = recoveredFiles }
                }
                self.reconcileFiles(in: &job)
                if job.state == "running" && jobTasks.isEmpty && job.state != "completed" {
                    if job.files?.isEmpty == false {
                        job.state = "queued"
                        job.errors = []
                    } else {
                        job.state = "failed"
                        job.errors = ["This download was interrupted. Tap Download to retry."]
                    }
                    shouldRecover = true
                }
                jobs[jobId] = job
                return job
            }) else {
                completion(.failure(DownloadError.jobNotFound))
                return
            }
            if job.state == "completed" {
                for task in jobTasks { task.cancel() }
            }
            if shouldRecover {
                self.recoverAndStartNextJob()
            }
            let handled = Set(job.handledTaskIds)
            let activeRequiredProgress = jobTasks.reduce(0.0) { partial, task in
                guard
                    !handled.contains(task.taskIdentifier),
                    let info = self.taskInfo(task),
                    info.jobId == jobId,
                    info.required,
                    task.countOfBytesExpectedToReceive > 0
                else { return partial }
                return partial + min(1, Double(task.countOfBytesReceived) / Double(task.countOfBytesExpectedToReceive))
            }
            let fraction = job.requiredTotal == 0
                ? 1
                : min(1, (Double(job.completedRequired) + activeRequiredProgress) / Double(job.requiredTotal))
            completion(.success((job.state, fraction, job.errors.first)))
        }
    }

    func handleEvents(identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == Self.sessionIdentifier else {
            completionHandler()
            return
        }
        self.completionHandler = completionHandler
        prepare()
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let info = taskInfo(downloadTask) else { return }
        guard let response = downloadTask.response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            record(downloadTask, info: info, succeeded: false)
            return
        }
        do {
            guard let destination = URL(string: info.destination), destination.isFileURL else {
                throw DownloadError.invalidDestination
            }
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: location, to: destination)
            record(downloadTask, info: info, succeeded: true)
        } catch {
            record(downloadTask, info: info, succeeded: false)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let info = taskInfo(task), error != nil else { return }
        record(task, info: info, succeeded: false)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let handler = completionHandler else { return }
        completionHandler = nil
        DispatchQueue.main.async(execute: handler)
    }

    private func taskInfo(_ task: URLSessionTask) -> StoredBackgroundTask? {
        guard let description = task.taskDescription, let data = description.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(StoredBackgroundTask.self, from: data)
    }

    private func record(_ task: URLSessionTask, info: StoredBackgroundTask, succeeded: Bool) {
        let finishedState = mutateJobs { jobs -> String? in
            guard
                var job = jobs[info.jobId],
                job.state != "completed",
                !job.handledTaskIds.contains(task.taskIdentifier)
            else { return nil }
            job.handledTaskIds.append(task.taskIdentifier)
            job.completed += 1
            if info.required {
                if succeeded {
                    job.completedRequired += 1
                } else {
                    job.errors.append("Could not download \(info.label).")
                }
            }
            if job.completed >= job.total {
                job.state = job.errors.isEmpty ? "completed" : "failed"
            }
            jobs[info.jobId] = job
            return job.state
        }
        if finishedState == "completed" || finishedState == "failed" {
            recoverAndStartNextJob()
        }
    }

    private func reconcileFiles(in job: inout StoredBackgroundJob) {
        guard let files = job.files, !files.isEmpty else { return }
        let existing = files.filter { info in
            guard let destination = URL(string: info.destination), destination.isFileURL else { return false }
            return FileManager.default.fileExists(atPath: destination.path)
        }
        job.completed = max(job.completed, existing.count)
        job.completedRequired = max(job.completedRequired, existing.filter(\.required).count)
        if job.requiredTotal == 0 || job.completedRequired >= job.requiredTotal {
            job.state = "completed"
            job.errors = []
        }
    }

    private func recoverAndStartNextJob() {
        session.getAllTasks { tasks in
            var tasksByJob: [String: [URLSessionTask]] = [:]
            for task in tasks {
                guard let info = self.taskInfo(task) else { continue }
                tasksByJob[info.jobId, default: []].append(task)
            }
            var tasksToCancel: [URLSessionTask] = []
            let tasksToResume = self.mutateJobs { jobs -> [URLSessionTask] in
                for jobId in Array(jobs.keys) {
                    guard var job = jobs[jobId] else { continue }
                    if job.files?.isEmpty != false {
                        let recoveredFiles = (tasksByJob[jobId] ?? []).compactMap(self.taskInfo)
                        if !recoveredFiles.isEmpty { job.files = recoveredFiles }
                    }
                    self.reconcileFiles(in: &job)
                    if job.state == "completed" {
                        tasksToCancel.append(contentsOf: tasksByJob[jobId] ?? [])
                    }
                    if job.state == "running" && job.state != "completed" && tasksByJob[jobId, default: []].isEmpty {
                        if job.files?.isEmpty == false {
                            job.state = "queued"
                            job.errors = []
                        } else {
                            job.state = "failed"
                            job.errors = ["This download was interrupted. Tap Download to retry."]
                        }
                    }
                    jobs[jobId] = job
                }

                let runningJobId = jobs.first { jobId, job in
                    job.state == "running" && !(tasksByJob[jobId] ?? []).isEmpty
                }?.key
                if let runningJobId {
                    return (tasksByJob[runningJobId] ?? []).filter { $0.state == .suspended }
                }

                guard let next = jobs
                    .filter({ $0.value.state == "queued" })
                    .min(by: {
                        ($0.value.enqueuedAt ?? 0, $0.key) < ($1.value.enqueuedAt ?? 0, $1.key)
                    })
                else { return [] }

                let jobId = next.key
                var job = next.value
                job.state = "running"
                job.errors = []
                var queuedTasks = tasksByJob[jobId] ?? []
                if queuedTasks.isEmpty, let files = job.files {
                    let existingFiles = files.filter { info in
                        guard let destination = URL(string: info.destination), destination.isFileURL else { return false }
                        return FileManager.default.fileExists(atPath: destination.path)
                    }
                    job.completed = existingFiles.count
                    job.completedRequired = existingFiles.filter(\.required).count
                    job.handledTaskIds = []
                    for info in files where !existingFiles.contains(where: { $0.destination == info.destination }) {
                        guard let sourceValue = info.source, let source = URL(string: sourceValue) else {
                            if info.required { job.errors.append("Could not restart \(info.label).") }
                            continue
                        }
                        let task = self.session.downloadTask(with: source)
                        task.taskDescription = String(data: (try? JSONEncoder().encode(info)) ?? Data(), encoding: .utf8)
                        task.priority = info.required ? URLSessionTask.highPriority : URLSessionTask.lowPriority
                        queuedTasks.append(task)
                    }
                }
                jobs[jobId] = job
                return queuedTasks
            }
            for task in tasksToCancel {
                task.cancel()
            }
            for task in tasksToResume {
                if !tasksToCancel.contains(where: { $0.taskIdentifier == task.taskIdentifier }) {
                    task.resume()
                }
            }
        }
    }

    private func mutateJobs<T>(_ mutation: (inout [String: StoredBackgroundJob]) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        let jobs: [String: StoredBackgroundJob]
        if let data = UserDefaults.standard.data(forKey: jobsKey) {
            jobs = (try? JSONDecoder().decode([String: StoredBackgroundJob].self, from: data)) ?? [:]
        } else {
            jobs = [:]
        }
        var mutableJobs = jobs
        let result = mutation(&mutableJobs)
        if let data = try? JSONEncoder().encode(mutableJobs) {
            UserDefaults.standard.set(data, forKey: jobsKey)
        }
        return result
    }

    private enum DownloadError: LocalizedError {
        case invalidFiles
        case invalidDestination
        case jobNotFound

        var errorDescription: String? {
            switch self {
            case .invalidFiles: return "At least one file is required."
            case .invalidDestination: return "A download destination is invalid."
            case .jobNotFound: return "The background download was not found."
            }
        }
    }
}

@objc(BackgroundDownloadsPlugin)
public class BackgroundDownloadsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundDownloadsPlugin"
    public let jsName = "BackgroundDownloads"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enqueueBook", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    @objc func enqueueBook(_ call: CAPPluginCall) {
        guard
            let jobId = call.getString("jobId"),
            let title = call.getString("title"),
            let values = call.getArray("files", JSObject.self),
            !values.isEmpty
        else {
            call.reject("A job ID, title, and at least one file are required.")
            return
        }

        do {
            let files = try values.map { value -> BackgroundDownloadFile in
                guard
                    let sourceValue = value["url"] as? String,
                    let source = URL(string: sourceValue),
                    let destinationValue = value["path"] as? String,
                    let destination = URL(string: destinationValue),
                    destination.isFileURL
                else { throw PluginError.invalidFile }
                return BackgroundDownloadFile(
                    source: source,
                    destination: destination,
                    label: value["label"] as? String ?? "file",
                    required: value["required"] as? Bool ?? true
                )
            }
            try BackgroundDownloadManager.shared.enqueue(jobId: jobId, title: title, files: files)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        guard let jobId = call.getString("jobId") else {
            call.reject("A job ID is required.")
            return
        }
        BackgroundDownloadManager.shared.status(jobId: jobId) { result in
            switch result {
            case .success(let status):
                var response: JSObject = ["state": status.0, "fraction": status.1]
                if let error = status.2 { response["error"] = error }
                call.resolve(response)
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }
    }

    private enum PluginError: LocalizedError {
        case invalidFile

        var errorDescription: String? { "A background download file is invalid." }
    }
}
