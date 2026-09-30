import outlines from './outlines.generated.json';

/**
 * The generated pool artifact, behind a module of its own.
 *
 * `index.ts` reads the pool through here so the artifact can be swapped for
 * `outlines.fixture.generated.json` in test mode, which gives every test a pool
 * that does not move when the curated selection changes. A test that wants the
 * committed artifact itself imports `./outlines.generated.json` directly.
 */
export default outlines;
