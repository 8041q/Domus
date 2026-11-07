import { Button, Icon } from './ui';
import { version as appVersion } from '../package.json';

const REPO = 'https://github.com/8041q/Domus';

const EXTERNAL_SVG = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 18l-3-3a1 1 0 0 0-1.4 1.4L12 16l-2.8 2.8a1 1 0 0 0 1.4 1.4L15 19l3-3a1 1 0 0 0-1.4-1.4L12 15l2.8-2.8a1 1 0 0 0 0-1.4z"/>
  </svg>
);

export function About({ onClose }: { onClose: () => void }) {
  const isMac = navigator.platform === 'MacIntel' || navigator.platform === 'MacPPC' || navigator.platform === 'Mac68k';

  return (
    <section className="about-page" aria-labelledby="about-title">
      <header className="about-head">
        <div className="about-back-row">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={onClose} className="about-back">
            <Icon name="arrowLeft" />
            <span className="about-back-text">Back</span>
          </Button>
        </div>
        <div className="about-header-row">
          <div className="about-logo">
            <img src="/brand/logo-mono-dark.svg" alt="Domus logo" width="96" height="96" />
          </div>
          <div className="about-title-block">
            <div className="about-title-row">
              <h1 id="about-title">Domus</h1>
              <span className="about-version-badge">v{appVersion}</span>
            </div>
            <p className="about-tagline">Design a room, arrange furniture, and explore your space in 3D.</p>
          </div>
        </div>
      </header>

      <p className="about-intro">
        Domus brings room planning into one workspace. Start with a room layout, add openings,
        furnish the space, and switch to 3D to explore the result.
      </p>

      <div className="about-callout">
        <span className="about-callout-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-8"/>
            <path d="M12 14h.01"/>
          </svg>
        </span>
        <p>
          Your rooms are saved in this browser on this device. Use
          <span className="about-callout-action">Project → Export room</span> to back them up or move them to another computer.
        </p>
      </div>

      <div className="about-two-col">
        <section className="about-section">
          <h2>What you can do</h2>
          <ul className="about-features">
            <li>
              <span className="about-check"><Icon name="pencil" width={16} height={16} /></span>
              <span>Draw and edit room layouts in 2D.</span>
            </li>
            <li>
              <span className="about-check"><Icon name="door" width={16} height={16} /></span>
              <span>Add doors, windows, and other openings.</span>
            </li>
            <li>
              <span className="about-check"><Icon name="sofa" width={16} height={16} /></span>
              <span>Place, move, and rotate furniture.</span>
            </li>
            <li>
              <span className="about-check"><Icon name="palette" width={16} height={16} /></span>
              <span>Change room colours, floors, and lighting.</span>
            </li>
            <li>
              <span className="about-check"><Icon name="3dcube" width={16} height={16} /></span>
              <span>Explore the design in 3D or at eye level.</span>
            </li>
          </ul>
        </section>

        <section className="about-section">
          <h2>Basic controls</h2>
          <div className="about-table-wrap">
            <table className="about-controls-table">
              <thead>
                <tr><th>Basic Controls</th><th>Key Bind</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>Undo / redo</td>
                  <td>
                    {isMac ? (
                      <span className="about-kbd-group">
                        <kbd>⌘Z</kbd>
                        /&nbsp;
                        <kbd>⇧⌘Z</kbd>
                        /&nbsp;
                        <kbd>⌘Y</kbd>
                      </span>
                    ) : (
                      <span className="about-kbd-group">
                        <kbd>Ctrl</kbd>
                        <span className="about-sep">or</span>
                        <kbd>Cmd</kbd>
                        <span className="about-sep">+</span>
                        <kbd>Z</kbd>
                        <span className="about-sep">/</span>
                        <kbd>Y</kbd>
                      </span>
                    )}
                  </td>
                </tr>
                <tr><td>Rotate selected furniture</td><td><kbd>R</kbd></td></tr>
                <tr><td>Remove selected furniture</td><td><span className="about-kbd-group"><kbd>Delete</kbd><span className="about-sep">or</span><kbd>Backspace</kbd></span></td></tr>
                <tr><td>Orbit the 3D view</td><td>Drag with the left mouse button</td></tr>
                <tr><td>Pan the 3D view</td><td>Drag with the right mouse button</td></tr>
                <tr><td>Zoom</td><td>Scroll</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <footer className="about-footer">
        <div className="about-footer-cols">
          <section className="about-footer-col">
            <h2>Open source</h2>
            <div className="about-footer-link-group">
              <a href={REPO} target="_blank" rel="noopener noreferrer" className="about-footer-link">
                github.com/8041q/Domus{EXTERNAL_SVG}
              </a>
              <a href={`${REPO}/issues`} target="_blank" rel="noopener noreferrer" className="about-footer-link">
                Report an issue{EXTERNAL_SVG}
              </a>
            </div>
          </section>
          <section className="about-footer-col">
            <h2>Built with</h2>
            <div className="about-stack-list">
              <a href="https://react.dev" target="_blank" rel="noopener noreferrer" className="about-stack-item">
                React 19
              </a>
              <a href="https://vitejs.dev" target="_blank" rel="noopener noreferrer" className="about-stack-item">
                Vite
              </a>
              <a href="https://threejs.org" target="_blank" rel="noopener noreferrer" className="about-stack-item">
                Three.js
              </a>
              <a href="https://zustand.github.io" target="_blank" rel="noopener noreferrer" className="about-stack-item">
                Zustand
              </a>
              <a href="https://www.typescriptlang.org" target="_blank" rel="noopener noreferrer" className="about-stack-item">
                TypeScript
              </a>
            </div>
          </section>
          <section className="about-footer-col">
            <h2>Credits</h2>
            <div className="about-credits-content">
              <div>
                Interface font:
                <a href="https://fonts.google.com/specimen/IBM+Plex+Sans" target="_blank" rel="noopener noreferrer" className="about-footer-link">
                  IBM Plex Sans
                </a>
              </div>
              <span className="about-font-license">SIL Open Font License</span>
            </div>
          </section>
        </div>
      </footer>
    </section>
  );
}
