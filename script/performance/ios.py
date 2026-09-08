#!/usr/bin/env python3
"""Generate a test-only Xcode project using real plugin sources; own the simulator lifecycle."""
import json
import os
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('PERF_OUTPUT_DIR', ROOT / 'output/performance')) / 'ios'
OUT.mkdir(parents=True, exist_ok=True)
PROJECT = OUT / 'Performance.xcodeproj'
PROJECT.mkdir(exist_ok=True)
objects = {}
def add(kind, fields):
    identifier = f'{len(objects)+1:024X}'
    objects[identifier] = f'isa = {kind}; {fields}'
    return identifier

def quote(value): return json.dumps(str(value))
files = [ROOT / 'apps/web/ios/App/App' / name for name in
         ['NativeAudio.swift', 'AudiobookPlayer.swift', 'CarLibrary.swift', 'CarLibraryStore.swift',
          'CarPlayCoordinator.swift', 'BackgroundDownloads.swift', 'BackgroundDownloadPolicy.swift']]
files += [ROOT / 'apps/web/ios/Tests/PerformanceTests.swift']
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
bundle = add('PBXFileReference', 'explicitFileType = wrapper.cfbundle; path = PerformanceTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
group = add('PBXGroup', f'children = ({",".join(refs + [bundle])}); sourceTree = "<group>";')
settings = '''CLANG_ENABLE_MODULES = YES; GENERATE_INFOPLIST_FILE = YES; SWIFT_VERSION = 5.0;
IPHONEOS_DEPLOYMENT_TARGET = 15.0; SDKROOT = iphoneos; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
TARGETED_DEVICE_FAMILY = "1,2"; PRODUCT_BUNDLE_IDENTIFIER = com.operalibre.performance.tests;
PRODUCT_NAME = "$(TARGET_NAME)"; CODE_SIGNING_ALLOWED = NO;
LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks";
SWIFT_OPTIMIZATION_LEVEL = "-O";'''
config = add('XCBuildConfiguration', f'name = Release; buildSettings = {{{settings}}};')
configs = add('XCConfigurationList', f'buildConfigurations = ({config}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
target = add('PBXNativeTarget', f'buildConfigurationList = {configs}; buildPhases = ({source},{frameworks}); buildRules = (); dependencies = (); name = PerformanceTests; productName = PerformanceTests; productReference = {bundle}; productType = "com.apple.product-type.bundle.unit-test"; packageProductDependencies = ({product},{cordova});')
project = add('PBXProject', f'attributes = {{LastUpgradeCheck = 2600;}}; buildConfigurationList = {configs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base); mainGroup = {group}; projectDirPath = ""; projectRoot = ""; targets = ({target}); packageReferences = ({package});')
(PROJECT / 'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(f'{key} = {{{value}}};' for key,value in objects.items()) + f'\n}}; rootObject = {project}; }}\n')
schemes = PROJECT / 'xcshareddata/xcschemes'; schemes.mkdir(parents=True, exist_ok=True)
ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="PerformanceTests.xctest" BlueprintName="PerformanceTests" ReferencedContainer="container:Performance.xcodeproj"/>'
(schemes / 'Performance.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref}</TestableReference></Testables></TestAction></Scheme>''')

def run(*args, **kwargs): return subprocess.run(args, check=True, **kwargs)
runtimes = json.loads(subprocess.check_output(['xcrun','simctl','list','runtimes','-j']))['runtimes']
runtime_info = next((r for r in reversed(runtimes) if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')), None)
if runtime_info is None: raise SystemExit('Install an iOS Simulator runtime in Xcode first.')
runtime = runtime_info['identifier']
device_types = runtime_info['supportedDeviceTypes']
device_type = os.environ.get('PERF_IOS_DEVICE_TYPE') or next(d['identifier'] for d in device_types if d['name'].startswith('iPhone'))
simulator = subprocess.check_output(['xcrun','simctl','create','Performance-'+uuid.uuid4().hex[:8],device_type,runtime], text=True).strip()
try:
    run('xcrun','simctl','boot',simulator)
    run('xcrun','simctl','bootstatus',simulator,'-b')
    result = OUT / ('run-'+uuid.uuid4().hex[:8]+'.xcresult')
    run('xcodebuild','-project',str(PROJECT),'-scheme','Performance','-configuration','Release',
        '-destination','platform=iOS Simulator,id='+simulator,'-derivedDataPath',str(OUT/'DerivedData'),
        '-resultBundlePath',str(result),'-parallel-testing-enabled','NO',
        '-test-timeouts-enabled','YES','-maximum-test-execution-time-allowance','120','-quiet','test')
    for kind in ['summary', 'metrics']:
        contents = subprocess.check_output(['xcrun', 'xcresulttool', 'get', 'test-results', kind, '--path', str(result)])
        (OUT / (kind + '.json')).write_bytes(contents)
    print('Native results:', result)
finally:
    subprocess.run(['xcrun','simctl','shutdown',simulator], check=False)
    subprocess.run(['xcrun','simctl','delete',simulator], check=False)
