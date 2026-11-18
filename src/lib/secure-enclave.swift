import CryptoKit
import Foundation
import LocalAuthentication
import Security

private struct Request: Decodable {
    let operation: String
    let wrapped: Data?
    let message: Data?
    let label: String?
}

private struct Response: Encodable {
    var available: Bool?
    var publicKey: Data?
    var wrapped: Data?
    var signature: Data?
}

private enum EnclaveError: Error { case unavailable, invalidRequest, accessControl }

private func handle(_ request: Request) throws -> Response {
    if request.operation == "probe" {
        return Response(available: SecureEnclave.isAvailable)
    }
    guard SecureEnclave.isAvailable else { throw EnclaveError.unavailable }
    switch request.operation {
    case "create":
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error
        ) else { throw EnclaveError.accessControl }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        return Response(publicKey: key.publicKey.compressedRepresentation, wrapped: key.dataRepresentation)
    case "sign":
        guard let wrapped = request.wrapped, let message = request.message, let label = request.label else {
            throw EnclaveError.invalidRequest
        }
        let context = LAContext()
        context.localizedReason = "Sign Harbor transaction with \(label)"
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: wrapped, authenticationContext: context)
        return Response(signature: try key.signature(for: message).rawRepresentation)
    default:
        throw EnclaveError.invalidRequest
    }
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let request = try JSONDecoder().decode(Request.self, from: input)
    try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(handle(request)))
} catch {
    // Return only the OS error domain and code. The request and wrapped key stay off stderr.
    let failure = error as NSError
    FileHandle.standardError.write(Data("\(failure.domain) \(failure.code)\n".utf8))
    exit(1)
}
