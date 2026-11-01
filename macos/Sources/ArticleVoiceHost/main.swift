import Foundation
import Darwin

// A small signed executable gives Chrome a stable native host. exec replaces
// this process, so closing the Chrome port also closes the HTTP request.
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let resources = executable.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources")
let python = resources.appendingPathComponent("Python/bin/python3.12").path
setenv("PYTHONHOME", resources.appendingPathComponent("Python").path, 1)
setenv("PYTHONPATH", resources.appendingPathComponent("PythonPackages").path, 1)
setenv("PYTHONNOUSERSITE", "1", 1)
setenv("PYTHONDONTWRITEBYTECODE", "1", 1)
setenv("TOKENIZERS_PARALLELISM", "false", 1)
let arguments = [python, "-s", "-u", resources.appendingPathComponent("local/native_host.py").path] + CommandLine.arguments.dropFirst()
let pointers = arguments.map { strdup($0) } + [nil]
pointers.withUnsafeBufferPointer { buffer in
    _ = execv(python, UnsafeMutablePointer(mutating: buffer.baseAddress!))
}
fputs("Article Voice could not start its bundled voice runtime.\n", stderr)
exit(1)
