import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildExplorer() {
  if (process.platform !== 'win32') return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE || (process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc');
  const architecture = triple.startsWith('aarch64-') ? 'arm64' : triple.startsWith('x86_64-') ? 'x64' : null;
  if (!architecture) throw new Error('The modern Explorer extension supports x64 and ARM64 Windows only.');
  const run = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${executable} failed (${result.status})`);
  };
  const sdkRoot = join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Windows Kits/10/bin');
  const sdk = existsSync(sdkRoot) && readdirSync(sdkRoot).filter(name => /^10\./.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(sdkRoot, name, process.arch === 'arm64' ? 'arm64' : 'x64'))
    .find(path => existsSync(join(path, 'makeappx.exe')));
  if (!sdk) throw new Error('Install the Windows SDK to build the Explorer identity package (MakeAppx.exe).');
  const generated = join(root, 'src-tauri/windows/generated');
  const target = join(root, 'src-tauri/target/shell-extension');
  run('cargo', ['build', '--manifest-path', 'src-tauri/shell-extension/Cargo.toml', '--target-dir', target, '--target', triple, '--release', '--locked']);
  mkdirSync(join(generated, 'Assets'), { recursive: true });
  copyFileSync(join(target, triple, 'release/wterm_shell.dll'), join(generated, 'wterm_shell.dll'));
  const version = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Explorer package requires a numeric three-part application version.');
  const manifest = readFileSync(join(root, 'src-tauri/windows/AppxManifest.xml.template'), 'utf8')
    .replace('@VERSION@', `${version}.0`).replace('@ARCH@', architecture);
  writeFileSync(join(generated, 'AppxManifest.xml'), manifest);
  for (const name of ['Logo.png', 'SmallLogo.png', 'StoreLogo.png']) {
    copyFileSync(join(root, 'src-tauri/icons/128x128.png'), join(generated, 'Assets', name));
  }
  // Sparse package contains only the identity and logos. The exe and DLL remain external.
  const staging = join(target, 'identity');
  mkdirSync(join(staging, 'Assets'), { recursive: true });
  copyFileSync(join(generated, 'AppxManifest.xml'), join(staging, 'AppxManifest.xml'));
  for (const name of ['Logo.png', 'SmallLogo.png', 'StoreLogo.png']) {
    copyFileSync(join(generated, 'Assets', name), join(staging, 'Assets', name));
  }
  const packagePath = join(generated, 'wterm-explorer.msix');
  run(join(sdk, 'makeappx.exe'), ['pack', '/d', staging, '/p', packagePath, '/o', '/nv']);
  // Release signing uses an existing trusted certificate; no certificates or policies are installed.
  if (process.env.WTERM_EXPLORER_CERT_THUMBPRINT) {
    const args = ['sign', '/sha1', process.env.WTERM_EXPLORER_CERT_THUMBPRINT, '/fd', 'SHA256'];
    if (process.env.WTERM_EXPLORER_TIMESTAMP_URL) args.push('/tr', process.env.WTERM_EXPLORER_TIMESTAMP_URL, '/td', 'SHA256');
    run(join(sdk, 'signtool.exe'), [...args, packagePath]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildExplorer();
