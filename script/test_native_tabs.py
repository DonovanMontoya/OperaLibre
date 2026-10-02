#!/usr/bin/env python3
"""Run native tab regression tests on an already opened iOS simulator.

Usage: python3 script/test_native_tabs.py <simulator-udid>
Requires npm ci and Xcode. Does not install or modify the OperaLibre app.
"""
import json
import sys
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
if len(sys.argv) != 2:
    raise SystemExit(__doc__)
OUT = ROOT / 'output/native-tabs-tests'
OUT.mkdir(parents=True, exist_ok=True)
PROJECT = OUT / 'NativeTabs.xcodeproj'
PROJECT.mkdir(exist_ok=True)
objects = {}
def add(kind, fields):
    identifier = f'{len(objects)+1:024X}'
    objects[identifier] = f'isa = {kind}; {fields}'
    return identifier

def quote(value): return json.dumps(str(value))
# Exercise the real UIKit controller without booting Capacitor's web app and
# unrelated plugins inside a hostless XCTest bundle.
(OUT / 'ViewController.swift').write_text(
    'import UIKit\nimport WebKit\nclass ViewController: UIViewController { var webView: WKWebView? }\n')
files = [ROOT / 'apps/web/ios/App/App/NativeTabs.swift',
         ROOT / 'apps/web/ios/App/App/DeviceFold.swift',
         ROOT / 'apps/web/ios/Tests/NativeTabsTests.swift',
         ROOT / 'apps/web/ios/Tests/DeviceFoldTests.swift', OUT / 'ViewController.swift']
refs = [add('PBXFileReference', f'lastKnownFileType = sourcecode.swift; path = {quote(p)}; sourceTree = "<absolute>";') for p in files]
builds = [add('PBXBuildFile', f'fileRef = {ref};') for ref in refs]
source = add('PBXSourcesBuildPhase', f'buildActionMask = 2147483647; files = ({",".join(builds)}); runOnlyForDeploymentPostprocessing = 0;')
# Resolve from the consuming workspace so both nested and hoisted installs work.
version = subprocess.check_output(
    ['node', '-p', "require('@capacitor/ios/package.json').version"],
    cwd=ROOT / 'apps/web', text=True).strip()
package = add('XCRemoteSwiftPackageReference', f'repositoryURL = "https://github.com/ionic-team/capacitor-swift-pm.git"; requirement = {{kind = exactVersion; version = {quote(version)};}};')
product = add('XCSwiftPackageProductDependency', f'package = {package}; productName = Capacitor;')
framework = add('PBXBuildFile', f'productRef = {product};')
cordova = add('XCSwiftPackageProductDependency', f'package = {package}; productName = Cordova;')
cordova_build = add('PBXBuildFile', f'productRef = {cordova};')
frameworks = add('PBXFrameworksBuildPhase', f'buildActionMask = 2147483647; files = ({framework},{cordova_build}); runOnlyForDeploymentPostprocessing = 0;')
bundle = add('PBXFileReference', 'explicitFileType = wrapper.cfbundle; path = NativeTabsTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
group = add('PBXGroup', f'children = ({",".join(refs + [bundle])}); sourceTree = "<group>";')
settings = '''CLANG_ENABLE_MODULES = YES; GENERATE_INFOPLIST_FILE = YES; SWIFT_VERSION = 5.0;
IPHONEOS_DEPLOYMENT_TARGET = 15.0; SDKROOT = iphoneos; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
TARGETED_DEVICE_FAMILY = "1,2"; PRODUCT_BUNDLE_IDENTIFIER = com.operalibre.native-tabs.tests;
PRODUCT_NAME = "$(TARGET_NAME)"; CODE_SIGNING_ALLOWED = NO;
LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks";
SWIFT_OPTIMIZATION_LEVEL = "-O";'''
config = add('XCBuildConfiguration', f'name = Release; buildSettings = {{{settings}}};')
configs = add('XCConfigurationList', f'buildConfigurations = ({config}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
target = add('PBXNativeTarget', f'buildConfigurationList = {configs}; buildPhases = ({source},{frameworks}); buildRules = (); dependencies = (); name = NativeTabsTests; productName = NativeTabsTests; productReference = {bundle}; productType = "com.apple.product-type.bundle.unit-test"; packageProductDependencies = ({product},{cordova});')
project = add('PBXProject', f'attributes = {{LastUpgradeCheck = 2600;}}; buildConfigurationList = {configs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base); mainGroup = {group}; projectDirPath = ""; projectRoot = ""; targets = ({target}); packageReferences = ({package});')
(PROJECT / 'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(f'{key} = {{{value}}};' for key,value in objects.items()) + f'\n}}; rootObject = {project}; }}\n')
schemes = PROJECT / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="NativeTabsTests.xctest" BlueprintName="NativeTabsTests" ReferencedContainer="container:NativeTabs.xcodeproj"/>'
(schemes / 'NativeTabs.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref}</TestableReference></Testables></TestAction></Scheme>''')

subprocess.run([
    'xcodebuild', '-project', str(PROJECT), '-scheme', 'NativeTabs',
    '-configuration', 'Release', '-destination', 'platform=iOS Simulator,id=' + sys.argv[1],
    '-derivedDataPath', str(OUT / 'DerivedData'), '-parallel-testing-enabled', 'NO',
    '-test-timeouts-enabled', 'YES', '-maximum-test-execution-time-allowance', '30', 'test'
], check=True)
