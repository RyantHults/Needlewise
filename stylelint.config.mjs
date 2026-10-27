/**
 * Colour discipline only: every UI colour is a theme token, and the theme files
 * in src/themes/ are the one place colour literals live. The dev symbol picker
 * is a dev tool and keeps its own literals.
 */
export default {
  ignoreFiles: ['src/dev/**'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never'
  },
  overrides: [
    {
      files: ['src/themes/**/*.css'],
      rules: {
        'color-no-hex': null,
        'color-named': null
      }
    }
  ]
};
