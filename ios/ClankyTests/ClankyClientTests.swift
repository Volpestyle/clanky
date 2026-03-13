import XCTest
@testable import Clanky

final class ClankyClientTests: XCTestCase {
    func testHttpErrorDescriptionIncludesStatusAndBody() {
        let error = ClankyClientError.http(statusCode: 404, body: #"{"error":"Not found."}"#)

        XCTAssertEqual(error.errorDescription, #"HTTP 404: {"error":"Not found."}"#)
    }

    func testHttpErrorDescriptionOmitsEmptyBody() {
        let error = ClankyClientError.http(statusCode: 401, body: "   ")

        XCTAssertEqual(error.errorDescription, "HTTP 401")
    }
}
