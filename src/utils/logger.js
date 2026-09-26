/** Tiny leveled logger — zero dependencies, structured enough for pm2/docker logs. */
const stamp = () => new Date().toISOString();
const write = (level, args) => {
  const line = `[${stamp()}] ${level.toUpperCase()}`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line, ...args);
};

module.exports = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  debug: (...a) => (process.env.NODE_ENV !== 'production' ? write('debug', a) : undefined),
};
