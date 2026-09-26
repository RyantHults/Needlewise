import { Link } from 'react-router-dom';

export function HomePage() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Needlewise home">
          <span className="brand-mark" aria-hidden="true">✣</span><span>Needlewise</span>
        </a>
      </header>

      <main id="home" className="home">
        <section className="hero home-hero">
          <div className="hero-copy">
            <p className="kicker">Cross-stitch, in the browser</p>
            <h1>Design cross-stitch patterns without leaving your browser.</h1>
            <p className="intro">Start from a blank canvas or convert a photo into stitches, then fine-tune colours, symbols, and thread materials as you go. Everything stays on this device, so Needlewise works offline and keeps your patterns private.</p>
            <div className="actions">
              <Link className="button button-primary home-cta" to="/patterns">Go to your patterns <span aria-hidden="true">→</span></Link>
            </div>
          </div>
          <div className="hero-stitches" aria-hidden="true">
            <span>✕✕✕</span>
            <span>✕✕✕</span>
            <span>✕✕✕</span>
          </div>
        </section>

        <ul className="home-features">
          <li className="home-feature">
            <h2>Create your way</h2>
            <p>Start a blank pattern at any size, or convert an image into a chart to trace and refine.</p>
          </li>
          <li className="home-feature">
            <h2>Stitch, colour, plan</h2>
            <p>Edit stitches and symbols, work from a DMC-style palette, and plan the thread you'll need.</p>
          </li>
          <li className="home-feature">
            <h2>Private and offline</h2>
            <p>Projects stay on this device and work without a connection. Download a .needlewise archive to back one up.</p>
          </li>
        </ul>
      </main>
      <footer className="footer-note"><span aria-hidden="true">⌁</span> Local archives are your backup path <span className="footer-divider" aria-hidden="true">·</span> Keep a copy somewhere safe</footer>
    </div>
  );
}
