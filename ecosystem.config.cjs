/**
 * PM2 process file for EC2. Start with:  pm2 start ecosystem.config.cjs
 *
 * Cluster mode runs one process per instance and restarts crashed ones. Running several instances
 * is safe: the nightly billing job takes a Postgres advisory lock, so only one process runs it.
 */
module.exports = {
  apps: [
    {
      name: 'athletiq-api',
      cwd: __dirname,
      script: 'dist/server.js',
      // Loads ./.env (Node's built-in loader; real environment variables take precedence).
      node_args: '--env-file-if-exists=.env',
      exec_mode: 'cluster',
      instances: process.env.PM2_INSTANCES ?? 2,
      env: { NODE_ENV: 'production' },
      // Restart a process that leaks past this, instead of letting the box swap.
      max_memory_restart: '512M',
      // Graceful shutdown: the server drains connections for up to 20 s on SIGINT/SIGTERM.
      kill_timeout: 25_000,
      // Back off on crash loops (e.g. a bad .env) instead of hammering the database.
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      time: true,
      merge_logs: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
    },
  ],
};
