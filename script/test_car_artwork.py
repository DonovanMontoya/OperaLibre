#!/usr/bin/env python3
"""Run CarPlay artwork cache regressions in an isolated test bundle.

Usage: python3 script/test_car_artwork.py [booted-simulator-udid]
Requires Xcode. Without an argument, creates and removes its own simulator.
Does not install or modify the OperaLibre app.
"""
import json
import sys
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
if len(sys.argv) > 2:
    raise SystemExit(__doc__)
OUT = ROOT / 'output/car-artwork-tests'
OUT.mkdir(parents=True, exist_ok=True)
PROJECT = OUT / 'CarArtwork.xcodeproj'
PROJECT.mkdir(exist_ok=True)
objects = {}
def add(kind, fields):
    identifier = f'{len(objects)+1:024X}'
    objects[identifier] = f'isa = {kind}; {fields}'
    return identifier

def quote(value): return json.dumps(str(value))
# Compile the actual store and models; the tests replace only network image I/O.
files = [ROOT / 'apps/web/ios/App/App/CarLibrary.swift',
         ROOT / 'apps/web/ios/App/App/CarLibraryStore.swift',
         ROOT / 'apps/web/ios/Tests/CarArtworkTests.swift']
refs = [add('PBXFileReference', f'lastKnownFileType = sourcecode.swift; path = {quote(p)}; sourceTree = "<absolute>";') for p in files]
builds = [add('PBXBuildFile', f'fileRef = {ref};') for ref in refs]
source = add('PBXSourcesBuildPhase', f'buildActionMask = 2147483647; files = ({",".join(builds)}); runOnlyForDeploymentPostprocessing = 0;')
frameworks = add('PBXFrameworksBuildPhase', 'buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
bundle = add('PBXFileReference', 'explicitFileType = wrapper.cfbundle; path = CarArtworkTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
group = add('PBXGroup', f'children = ({",".join(refs + [bundle])}); sourceTree = "<group>";')
settings = '''CLANG_ENABLE_MODULES = YES; GENERATE_INFOPLIST_FILE = YES; SWIFT_VERSION = 5.0;
IPHONEOS_DEPLOYMENT_TARGET = 15.0; SDKROOT = iphoneos; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
TARGETED_DEVICE_FAMILY = "1,2"; PRODUCT_BUNDLE_IDENTIFIER = com.operalibre.car-artwork.tests;
PRODUCT_NAME = "$(TARGET_NAME)"; CODE_SIGNING_ALLOWED = NO;
LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks";
SWIFT_OPTIMIZATION_LEVEL = "-O";'''
config = add('XCBuildConfiguration', f'name = Release; buildSettings = {{{settings}}};')
configs = add('XCConfigurationList', f'buildConfigurations = ({config}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
target = add('PBXNativeTarget', f'buildConfigurationList = {configs}; buildPhases = ({source},{frameworks}); buildRules = (); dependencies = (); name = CarArtworkTests; productName = CarArtworkTests; productReference = {bundle}; productType = "com.apple.product-type.bundle.unit-test"; packageProductDependencies = ();')
project = add('PBXProject', f'attributes = {{LastUpgradeCheck = 2600;}}; buildConfigurationList = {configs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base); mainGroup = {group}; projectDirPath = ""; projectRoot = ""; targets = ({target}); packageReferences = ();')
(PROJECT / 'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(f'{key} = {{{value}}};' for key,value in objects.items()) + f'\n}}; rootObject = {project}; }}\n')
schemes = PROJECT / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="CarArtworkTests.xctest" BlueprintName="CarArtworkTests" ReferencedContainer="container:CarArtwork.xcodeproj"/>'
(schemes / 'CarArtwork.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref}</TestableReference></Testables></TestAction></Scheme>''')

owned_simulator = len(sys.argv) == 1
if owned_simulator:
    runtimes = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'runtimes', '-j']))['runtimes']
    runtime = next((r for r in reversed(runtimes) if r.get('isAvailable')
                    and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')), None)
    if runtime is None:
        raise SystemExit('Install an iOS Simulator runtime in Xcode first.')
    device_type = next(d['identifier'] for d in runtime['supportedDeviceTypes'] if d['name'].startswith('iPhone'))
    simulator = subprocess.check_output(['xcrun', 'simctl', 'create', 'CoverTests-' + uuid.uuid4().hex[:8],
                                         device_type, runtime['identifier']], text=True).strip()
else:
    simulator = sys.argv[1]
try:
    if owned_simulator:
        subprocess.run(['xcrun', 'simctl', 'boot', simulator], check=True)
        subprocess.run(['xcrun', 'simctl', 'bootstatus', simulator, '-b'], check=True)
    subprocess.run([
        'xcodebuild', '-project', str(PROJECT), '-scheme', 'CarArtwork',
        '-configuration', 'Release', '-destination', 'platform=iOS Simulator,id=' + simulator,
        '-derivedDataPath', str(OUT / 'DerivedData'), '-parallel-testing-enabled', 'NO',
        '-test-timeouts-enabled', 'YES', '-maximum-test-execution-time-allowance', '30', 'test'
    ], check=True)
finally:
    if owned_simulator:
        subprocess.run(['xcrun', 'simctl', 'shutdown', simulator], check=False)
        subprocess.run(['xcrun', 'simctl', 'delete', simulator], check=False)
