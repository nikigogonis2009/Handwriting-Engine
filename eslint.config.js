module.exports = [
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly', location: 'readonly', history: 'readonly',
        requestAnimationFrame: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', alert: 'readonly', confirm: 'readonly',
        Path2D: 'readonly', ResizeObserver: 'readonly', PointerEvent: 'readonly', Event: 'readonly', CustomEvent: 'readonly', atob: 'readonly', TextEncoder: 'readonly', createImageBitmap: 'readonly', Blob: 'readonly', File: 'readonly',
        URL: 'readonly', globalThis: 'readonly', module: 'writable', require: 'readonly', process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', console: 'readonly',
      },
    },
    rules: { 'no-unused-vars': ['error', { args: 'none' }], 'no-undef': 'error' },
  },
];
