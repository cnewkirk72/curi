// Phase 5.7.1 — Capacitor plugin registration for SpotifyConnect.
//
// Capacitor uses Objective-C's runtime introspection to discover
// plugins. The CAP_PLUGIN macro emits the registration boilerplate
// so SpotifyConnectPlugin.swift's @objc methods become callable
// from JavaScript via Capacitor's bridge.
//
// Methods registered here MUST match @objc methods declared in
// SpotifyConnectPlugin.swift. Keep these two files in sync — adding
// a method on the Swift side requires CAP_PLUGIN_METHOD entry here.

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(SpotifyConnectPlugin, "SpotifyConnect",
           CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(refresh, CAPPluginReturnPromise);
)
