import CoreLocation
import MapKit
import PorchUI
import SwiftUI

/// One located stop on a package's route.
struct RouteStop: Hashable {
    var place: String
    var latitude: Double
    var longitude: Double

    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
}

/// The package's path on a calm map: an Accent line through the located
/// stops in order, a dot per stop (the newest larger), framed tight on the
/// stops. The caller shows it only when at least one stop was located.
struct RouteMap: View {
    let stops: [RouteStop]

    var body: some View {
        Map(initialPosition: camera, interactionModes: [.pan, .zoom]) {
            if stops.count > 1 {
                MapPolyline(coordinates: stops.map(\.coordinate))
                    .stroke(PorchColor.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
            // MapCircle, not Annotation: overlays draw wherever the map does.
            // The radius follows the framed area, so a dot stays a dot at any zoom.
            ForEach(Array(stops.enumerated()), id: \.offset) { index, stop in
                let newest = index == stops.count - 1
                MapCircle(center: stop.coordinate, radius: dotRadius * (newest ? 1.4 : 1))
                    .foregroundStyle(PorchColor.accent)
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .mapControls {}
        .frame(height: 220)
        .clipShape(RoundedRectangle(cornerRadius: PorchRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PorchRadius.card, style: .continuous).strokeBorder(PorchColor.line2, lineWidth: 1))
        .id(stops) // Re-frame the camera when the stops change.
        .accessibilityElement()
        .accessibilityLabel("Route map")
        .accessibilityValue(stops.map(\.place).joined(separator: ", then "))
    }

    /// The stops' bounding box with a margin, so the route fills the map;
    /// a lone stop (or stops in one town) gets a regional zoom, not street level.
    private var region: MKCoordinateRegion {
        let lats = stops.map(\.latitude)
        let lons = stops.map(\.longitude)
        let minLat = lats.min() ?? 0, maxLat = lats.max() ?? 0
        let minLon = lons.min() ?? 0, maxLon = lons.max() ?? 0
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2)
        let span = MKCoordinateSpan(
            latitudeDelta: max((maxLat - minLat) * Self.margin, Self.minimumSpan),
            longitudeDelta: max((maxLon - minLon) * Self.margin, Self.minimumSpan)
        )
        return MKCoordinateRegion(center: center, span: span)
    }

    private var camera: MapCameraPosition { .region(region) }

    /// About 3% of the framed height, in meters (a degree of latitude is ~111 km).
    private var dotRadius: CLLocationDistance { region.span.latitudeDelta * 111_000 * 0.03 }

    private static let margin = 1.5
    private static let minimumSpan = 0.1
}

/// Turns place names ("Oakland, CA") into coordinates on the device, one
/// lookup at a time. Results are kept in memory and in UserDefaults, so a
/// place is looked up once. A failed lookup leaves that stop out.
@MainActor
enum PlaceLocator {
    private static let storageKey = "porchlight.placeCoordinates"
    private static var memory: [String: [Double]] = UserDefaults.standard.dictionary(forKey: storageKey) as? [String: [Double]] ?? [:]

    static func locate(_ places: [String]) async -> [RouteStop] {
        var stops: [RouteStop] = []
        for place in places {
            if Task.isCancelled { break }
            guard let pair = await coordinates(place) else { continue }
            stops.append(RouteStop(place: place, latitude: pair[0], longitude: pair[1]))
        }
        return stops
    }

    private static func coordinates(_ place: String) async -> [Double]? {
        if let cached = memory[place], cached.count == 2 { return cached }
        guard let coordinate = await lookUp(place) else { return nil }
        let pair = [coordinate.latitude, coordinate.longitude]
        memory[place] = pair
        UserDefaults.standard.set(memory, forKey: storageKey)
        return pair
    }

    private static func lookUp(_ place: String) async -> CLLocationCoordinate2D? {
        if #available(iOS 26.0, macOS 26.0, *) {
            guard let request = MKGeocodingRequest(addressString: place) else { return nil }
            return try? await request.mapItems.first?.location.coordinate
        } else {
            return try? await CLGeocoder().geocodeAddressString(place).first?.location?.coordinate
        }
    }
}
