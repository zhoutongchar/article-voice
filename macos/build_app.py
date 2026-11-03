"""Build a self-contained Apple Silicon developer preview without system installs."""
import json
import hashlib
import os
import plistlib
import shutil
import subprocess
import sys
import zipfile
import argparse
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--release', action='store_true', help='Require Developer ID, notarization, and the published Chrome listing')
args = parser.parse_args()
connection = json.loads((ROOT / 'chrome' / 'connection.json').read_text())
version = json.loads((ROOT / 'package.json').read_text())['version']
public_key = base64.b64decode(connection['extensionKey'], validate=True)
extension_id = ''.join(chr(97 + int(n, 16)) for n in hashlib.sha256(public_key).hexdigest()[:32])
if connection['extensionId'] != extension_id:
    raise SystemExit('The Chrome extension ID must match its public key. Copy both from the Chrome Web Store listing.')
if connection.get('storeUrl') and not (connection['storeUrl'].startswith('https://chromewebstore.google.com/detail/') and connection['storeUrl'].endswith('/' + extension_id)):
    raise SystemExit('storeUrl must point to this extension’s official Chrome Web Store listing.')
identity = os.environ.get('ARTICLE_VOICE_SIGN_IDENTITY')
notary_profile = os.environ.get('ARTICLE_VOICE_NOTARY_PROFILE')
if args.release and (not identity or not notary_profile or not connection.get('storeUrl')):
    raise SystemExit('Public release needs ARTICLE_VOICE_SIGN_IDENTITY, ARTICLE_VOICE_NOTARY_PROFILE, and a published storeUrl in chrome/connection.json. Preview builds do not require them.')
MAC = ROOT / 'macos'
APP = MAC / 'build' / 'Article Voice.app'
CONTENTS = APP / 'Contents'
RESOURCES = CONTENTS / 'Resources'


def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)


run('swift', 'build', '--package-path', str(MAC), '-c', 'release', '--product', 'ArticleVoice')
run('swift', 'build', '--package-path', str(MAC), '-c', 'release', '--product', 'ArticleVoiceHost')
run('swift', 'build', '--package-path', str(MAC), '-c', 'release', '--product', 'ArticleVoiceOCR')
run('node', 'scripts/build.mjs')
binary_dir = Path(subprocess.check_output(['swift', 'build', '--package-path', str(MAC), '-c', 'release', '--show-bin-path'], text=True).strip())
RESOURCES.mkdir(parents=True, exist_ok=True)
(CONTENTS / 'MacOS').mkdir(exist_ok=True)
shutil.copy2(binary_dir / 'ArticleVoice', CONTENTS / 'MacOS' / 'ArticleVoice')

# The app brings its own relocatable Python and locked inference dependencies.
# It never runs pip, Homebrew, uv, or npm on the user's machine.
python_base = Path(sys.base_prefix)
if not (python_base / 'bin' / 'python3.12').is_file():
    raise SystemExit('Run this builder using .venv/bin/python (Python 3.12).')
lock = (ROOT / 'local' / 'requirements-lock.txt').read_bytes()
fingerprint = hashlib.sha256(lock + sys.version.encode()).hexdigest()
marker = RESOURCES / 'runtime-fingerprint.txt'
refresh_runtime = not marker.exists() or marker.read_text() != fingerprint
if refresh_runtime and (RESOURCES / 'Python').exists():
    shutil.rmtree(RESOURCES / 'Python')
if refresh_runtime and (RESOURCES / 'PythonPackages').exists():
    shutil.rmtree(RESOURCES / 'PythonPackages')
if not (RESOURCES / 'Python').exists():
    shutil.copytree(python_base, RESOURCES / 'Python', symlinks=True,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
packages = ROOT / '.venv' / 'lib' / 'python3.12' / 'site-packages'
if not (RESOURCES / 'PythonPackages').exists():
    shutil.copytree(packages, RESOURCES / 'PythonPackages', symlinks=False,
                    ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
marker.write_text(fingerprint)
(RESOURCES / 'local').mkdir(exist_ok=True)
for name in ('server.py', 'runtime.py', 'contracts.py', 'artifact_store.py', 'stage_executor.py', 'references.py', 'streaming.py', 'speech-policy.json', 'text_cleanup.py', 'config.json', 'model-files.json', 'models.py', 'companion.py', 'native_host.py', 'setup.py'):
    shutil.copy2(ROOT / 'local' / name, RESOURCES / 'local' / name)
shutil.copytree(MAC / 'Resources' / 'Licenses', RESOURCES / 'Licenses', dirs_exist_ok=True)
shutil.copytree(ROOT / 'pipeline', RESOURCES / 'pipeline', dirs_exist_ok=True)
shutil.copytree(ROOT / 'chrome', RESOURCES / 'chrome', dirs_exist_ok=True)
if (RESOURCES / 'ChromeExtension').exists():
    shutil.rmtree(RESOURCES / 'ChromeExtension')
shutil.copytree(ROOT / 'dist', RESOURCES / 'ChromeExtension')
host = CONTENTS / 'MacOS' / 'ArticleVoiceHost'
host.unlink(missing_ok=True)
shutil.copy2(binary_dir / 'ArticleVoiceHost', host)
host.chmod(0o755)
ocr = CONTENTS / 'MacOS' / 'ArticleVoiceOCR'
shutil.copy2(binary_dir / 'ArticleVoiceOCR', ocr)
ocr.chmod(0o755)

sys.path.insert(0, str(ROOT / 'local'))
from references import ReferenceLibrary, canonical
config = json.loads((ROOT / 'local' / 'config.json').read_text())
library = ReferenceLibrary(config, ROOT / '.cache' / 'voice-references')
(RESOURCES / 'VoiceReferences').mkdir(exist_ok=True)
for voice in config['voices']:
    library.load(voice['id'], lambda _: (_ for _ in ()).throw(ValueError('Prepare local Qwen voices once before packaging.')))
    recipe = hashlib.sha256(canonical(library.descriptor(voice['id']))).hexdigest()
    shutil.copytree(library.directory / recipe, RESOURCES / 'VoiceReferences' / recipe, dirs_exist_ok=True)

info = {
    'CFBundleIdentifier': 'com.tong.articlevoice',
    'CFBundleName': 'Article Voice',
    'CFBundleDisplayName': 'Article Voice',
    'CFBundleExecutable': 'ArticleVoice',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': version,
    'CFBundleVersion': '23',
    'CFBundleIconFile': 'AppIcon',
    'NSPrincipalClass': 'NSApplication',
    'NSHighResolutionCapable': True,
    'LSMinimumSystemVersion': '26.0',
    'LSApplicationCategoryType': 'public.app-category.productivity',
    'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
    'CFBundleURLTypes': [{'CFBundleURLName': 'Article Voice setup', 'CFBundleURLSchemes': ['articlevoice']}],
}
with (CONTENTS / 'Info.plist').open('wb') as handle:
    plistlib.dump(info, handle)
iconset = MAC / 'build' / 'AppIcon.iconset'
run('swift', str(MAC / 'scripts' / 'MakeIcon.swift'), str(iconset))
run('iconutil', '-c', 'icns', str(iconset), '-o', str(RESOURCES / 'AppIcon.icns'))
if identity:
    run('codesign', '--force', '--deep', '--options', 'runtime', '--timestamp', '--sign', identity, str(APP))
else:
    run('codesign', '--force', '--sign', '-', str(host))
    run('codesign', '--force', '--sign', '-', str(ocr))
    run('codesign', '--force', '--sign', '-', str(APP))
run('codesign', '--verify', '--deep', '--strict', str(APP))
extension_zip = MAC / 'build' / 'Article Voice Chrome.zip'
with zipfile.ZipFile(extension_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((ROOT / 'dist').rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(ROOT / 'dist'))
app_zip = MAC / 'build' / 'Article Voice.zip'
run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(APP), str(app_zip))
if args.release:
    run('xcrun', 'notarytool', 'submit', str(app_zip), '--keychain-profile', notary_profile, '--wait')
    run('xcrun', 'stapler', 'staple', str(APP))
    run('ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(APP), str(app_zip))
print(f'Built {APP}', flush=True)
print(f'Download: {app_zip}', flush=True)
print(f'Chrome Web Store upload: {extension_zip}', flush=True)
