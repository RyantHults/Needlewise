/**
 * Colour discipline only: every UI colour is a theme token defined on :root in
 * src/styles.css, which opts out of these rules around that block. The dev
 * symbol picker is a dev tool and keeps its own literals.
 */
export default {
  ignoreFiles: ['src/dev/**'],
  rules: {
    'color-no-hex': true,
    'color-named': 'never'
  }
};
