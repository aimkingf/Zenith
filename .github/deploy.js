const Client = require('ssh2-sftp-client');
const fs = require('fs');

const sftp = new Client();

async function run() {
  const host = process.env.SFTP_HOST || 'fi9.bot-hosting.cloud';
  const port = parseInt(process.env.SFTP_PORT || '2022', 10);
  const username = process.env.SFTP_USERNAME || 'b3597b2d-ac85-429e-9b22-baf17e1cd50b.u9mg7ylz';
  const password = process.env.SFTP_PASSWORD || 'Ps7OO7O6KMPWia_SOf1noKZ2';

  console.log(`Connecting to ${host}:${port}...`);
  await sftp.connect({ host, port, username, password });
  console.log('Connected to Bot Hosting SFTP.');

  await sftp.mkdir('/home/container/src', true).catch(() => {});
  await sftp.mkdir('/home/container/src/public', true).catch(() => {});
  await sftp.mkdir('/home/container/data', true).catch(() => {});

  const files = [
    { local: 'index.js', remote: '/home/container/index.js' },
    { local: 'package.json', remote: '/home/container/package.json' },
    { local: 'package-lock.json', remote: '/home/container/package-lock.json' },
    { local: '.env', remote: '/home/container/.env' },
    { local: 'README.md', remote: '/home/container/README.md' },
    { local: 'src/bot.js', remote: '/home/container/src/bot.js' },
    { local: 'src/index.js', remote: '/home/container/src/index.js' },
    { local: 'src/store.js', remote: '/home/container/src/store.js' },
    { local: 'src/web.js', remote: '/home/container/src/web.js' },
    { local: 'src/public/index.html', remote: '/home/container/src/public/index.html' },
    { local: 'data/store.json', remote: '/home/container/data/store.json' },
  ];

  for (const f of files) {
    if (fs.existsSync(f.local)) {
      await sftp.put(f.local, f.remote);
      console.log(`[DEPLOYED] ${f.remote}`);
    }
  }

  console.log('Auto-Deploy completed! Server files updated successfully.');
  await sftp.end();
}

run().catch((err) => {
  console.error('Deploy error:', err);
  process.exit(1);
});
