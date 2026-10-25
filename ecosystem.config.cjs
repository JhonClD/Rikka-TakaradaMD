module.exports = {
  apps: [{
    name: 'rikka-takarada-md',
    script: './index.js',
    cwd: __dirname,
    interpreter: process.execPath,
    autorestart: true,
    watch: false,
    restart_delay: 5000,
    exp_backoff_restart_delay: 100,
    max_memory_restart: '512M',
    time: true,
    merge_logs: true,
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-error.log',
    env: {
      NODE_ENV: 'production',
      CR_MINUTES: '1',
    },
  }],
}
