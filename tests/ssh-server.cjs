// Independent SSH implementation. Loopback only, ephemeral keys, no real credentials.
const { Server, utils } = require('ssh2');
const net = require('node:net');
const passwordOnly = process.argv[2] === 'password';
const host = utils.generateKeyPairSync('ed25519');
const user = utils.generateKeyPairSync('ed25519');
const allowed = utils.parseKey(user.public);
const server = new Server({ hostKeys: [host.private] }, client => {
  let keyVerified = false;
  client.on('error', () => {});
  client.on('authentication', ctx => {
    if (passwordOnly) {
      if (ctx.method === 'password' && ctx.password === 'test-password') ctx.accept();
      else ctx.reject(['password']);
      return;
    }
    if (ctx.method === 'publickey') {
      if (!ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(['publickey']);
      if (!ctx.signature) return ctx.accept(); // Probe only: must not grant the first factor.
      if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
      keyVerified = true;
      return ctx.reject(['keyboard-interactive'], true);
    }
    if (ctx.method === 'keyboard-interactive' && keyVerified) {
      ctx.prompt([{ prompt: '[OTP Code]:', echo: false }], 'JumpServer fixture', 'Please Enter MFA Code.', answers => {
        if (answers[0] !== '123456') return ctx.reject(['keyboard-interactive']);
        ctx.prompt([{ prompt: 'Confirmation:', echo: true }], 'JumpServer fixture', 'Please Enter MFA Code.', next => {
          if (next[0] === 'confirm') ctx.accept();
          else ctx.reject(['keyboard-interactive']);
        });
      });
      return;
    }
    ctx.reject(keyVerified ? ['keyboard-interactive'] : ['publickey']);
  });
  client.on('ready', () => client.on('session', accept => {
    const session = accept();
    session.on('pty', acceptPty => acceptPty?.());
    session.on('shell', acceptShell => {
      const stream = acceptShell();
      stream.write('fixture> ');
      // Echo input bytes only: this fixture never executes received commands.
      stream.on('data', data => stream.write(data));
    });
    session.on('exec', acceptExec => { const stream = acceptExec(); stream.end('authenticated\n'); });
    session.on('sftp', acceptSftp => {
      const sftp = acceptSftp();
      const files = new Map(), modes = new Map();
      const { STATUS_CODE: S, OPEN_MODE: O } = utils.sftp;
      const attrs = (id, path) => files.has(path)
        ? sftp.attrs(id, { size: files.get(path).length, mode: modes.get(path) ?? 0o100644, uid: 0, gid: 0, atime: 0, mtime: 0 })
        : sftp.status(id, S.NO_SUCH_FILE);
      sftp.on('OPEN', (id, path, flags) => {
        if ((flags & O.EXCL) && files.has(path)) return sftp.status(id, S.FAILURE);
        if (!files.has(path) && !(flags & O.CREAT)) return sftp.status(id, S.NO_SUCH_FILE);
        if (!files.has(path) || (flags & O.TRUNC)) files.set(path, Buffer.alloc(0));
        sftp.handle(id, Buffer.from(path));
      });
      sftp.on('STAT', attrs).on('LSTAT', attrs);
      sftp.on('FSTAT', (id, handle) => attrs(id, handle.toString()));
      sftp.on('READ', (id, handle, offset, length) => {
        const data = files.get(handle.toString());
        if (!data) return sftp.status(id, S.NO_SUCH_FILE);
        if (offset >= data.length) return sftp.status(id, S.EOF);
        sftp.data(id, data.subarray(offset, offset + Math.min(length, 32768)));
      });
      sftp.on('WRITE', (id, handle, offset, data) => {
        const path = handle.toString(), old = files.get(path);
        if (!old) return sftp.status(id, S.NO_SUCH_FILE);
        const next = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(next); data.copy(next, offset); files.set(path, next);
        sftp.status(id, S.OK);
      });
      sftp.on('SETSTAT', (id, path, attributes) => { modes.set(path, attributes.mode); sftp.status(id, S.OK); });
      sftp.on('CLOSE', id => sftp.status(id, S.OK));
    });
  }));
  client.on('tcpip', (accept, reject, info) => {
    if (info.destIP !== '127.0.0.1' || info.destPort !== server.address().port) return reject();
    const socket = net.connect(info.destPort, info.destIP, () => {
      const channel = accept();
      channel.on('error', () => socket.destroy());
      channel.on('close', () => socket.destroy());
      socket.pipe(channel).pipe(socket);
    });
    socket.on('error', () => reject());
  });
});
// Independent agent wire fixture. It signs with an ephemeral private key kept only here.
const agentPipe = process.platform === 'win32' ? `\\\\.\\pipe\\wterm-agent-test-${process.pid}` : `/tmp/wterm-agent-test-${process.pid}.sock`;
const field = data => { data = Buffer.from(data); const n = Buffer.alloc(4); n.writeUInt32BE(data.length); return Buffer.concat([n, data]); };
net.createServer(socket => {
  let pending = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const size = pending.readUInt32BE(0), message = pending.subarray(4, 4 + size); pending = pending.subarray(4 + size);
      let reply = Buffer.from([5]);
      if (message[0] === 11) {
        reply = Buffer.concat([Buffer.from([12, 0, 0, 0, 1]), field(allowed.getPublicSSH()), field('fixture')]);
      } else if (message[0] === 13) {
        const offset = 5 + message.readUInt32BE(1);
        const data = message.subarray(offset + 4, offset + 4 + message.readUInt32BE(offset));
        const signature = utils.parseKey(user.private).sign(data);
        reply = Buffer.concat([Buffer.from([14]), field(Buffer.concat([field('ssh-ed25519'), field(signature)]))]);
      }
      socket.write(field(reply));
    }
  });
}).listen(agentPipe);
server.listen(0, '127.0.0.1', () => {
  // Private key is generated solely for this test and never written to disk.
  console.log(JSON.stringify({ port: server.address().port, privateKey: user.private, agentPipe }));
});
