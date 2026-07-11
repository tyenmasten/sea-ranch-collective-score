// Shared login for The Sea Ranch as Prototype.
//
// This is NOT real security. The two passwords below live in plain text in
// this file, anyone who views the page source can read them. What this
// actually does is attach a real first and last name plus a role (Faculty
// or Participant) to whatever someone saves, and stop casual, random
// visitors from writing into Firestore. Pages themselves are always freely
// viewable, login is only ever prompted at the moment someone tries to
// actually change something.
//
// CHANGE THESE two passwords before sharing the site with the cohort:
const PARTICIPANT_PASSWORD = '53aranch';
const FACULTY_PASSWORD = 'lightfoot';

const SESSION_KEY = 'searanch_session';

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  window.currentUser = session;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  window.currentUser = null;
  updateHeaderBadge();
}

function injectGateStyles() {
  if (document.getElementById('authGateStyles')) return;
  const style = document.createElement('style');
  style.id = 'authGateStyles';
  style.textContent = `
    #authGateOverlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.35);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999; font-family: 'Media77', sans-serif;
    }
    #authGateBox {
      background: #fff; border: 1px solid #ccc; padding: 32px;
      width: 280px; display: flex; flex-direction: column; gap: 14px;
      box-sizing: border-box;
    }
    #authGateBox h2 {
      font-family: 'Miniature', serif; font-size: 16px; font-weight: normal;
      margin: 0 0 4px; line-height: 1.2;
    }
    #authGateBox label {
      font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
      color: #888; display: block; margin-bottom: 4px;
    }
    #authGateBox input {
      width: 100%; box-sizing: border-box; padding: 8px;
      border: 1px solid #ccc; font-family: 'Media77', sans-serif; font-size: 12px;
      outline: none;
    }
    #authGateBox input:focus { border-color: #1a1a1a; }
    #authGateBox .authGateRow { display: flex; gap: 14px; }
    #authGateBox button {
      background: #1a1a1a; color: #fff; border: none; padding: 10px;
      font-family: 'Miniature', serif; font-size: 12px; letter-spacing: 0.1em;
      text-transform: uppercase; cursor: pointer; margin-top: 6px;
    }
    #authGateCancel {
      background: none; color: #888; text-decoration: underline;
      padding: 4px; margin-top: 0; text-transform: none; letter-spacing: normal;
      font-family: 'Media77', sans-serif; font-size: 11px;
    }
    #authGateError { color: #b00020; font-size: 11px; display: none; }
    .h-user.authLoggedOut { cursor: pointer; }
    .h-user.authLoggedOut:hover { border-color: var(--ink); color: var(--ink); }
    #authLogoutLink {
      font-family: 'Media77', sans-serif; font-size: 9px; color: var(--dim);
      text-decoration: underline; cursor: pointer; margin-top: 4px;
      background: none; border: none; padding: 0;
    }
  `;
  document.head.appendChild(style);
}

// Call this before any save, edit, or write action. If someone is already
// logged in, onSuccess runs immediately. If not, the login screen appears,
// and onSuccess only runs once they log in successfully. If they cancel,
// onSuccess never runs.
window.requireLogin = function requireLogin(onSuccess) {
  if (window.currentUser && window.currentUser.role) {
    onSuccess(window.currentUser);
    return;
  }
  showGate(onSuccess);
};

function showGate(onSuccess) {
  injectGateStyles();
  const overlay = document.createElement('div');
  overlay.id = 'authGateOverlay';
  overlay.innerHTML = `
    <div id="authGateBox">
      <h2>Log in to save changes</h2>
      <div>
        <label>First Name</label>
        <input type="text" id="authFirstName" autocomplete="given-name">
      </div>
      <div>
        <label>Last Name</label>
        <input type="text" id="authLastName" autocomplete="family-name">
      </div>
      <div>
        <label>Password</label>
        <input type="password" id="authPassword">
      </div>
      <div id="authGateError"></div>
      <button type="button" id="authGateSubmit">Log In</button>
      <button type="button" id="authGateCancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('authGateSubmit').addEventListener('click', submitGate);
  document.getElementById('authGateCancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitGate();
    if (e.key === 'Escape') overlay.remove();
  });

  function submitGate() {
    const firstName = document.getElementById('authFirstName').value.trim();
    const lastName = document.getElementById('authLastName').value.trim();
    const password = document.getElementById('authPassword').value;
    const errorEl = document.getElementById('authGateError');

    if (!firstName || !lastName) {
      errorEl.textContent = 'Please enter your first and last name.';
      errorEl.style.display = 'block';
      return;
    }

    let role = null;
    if (password === FACULTY_PASSWORD) role = 'faculty';
    else if (password === PARTICIPANT_PASSWORD) role = 'participant';

    if (!role) {
      errorEl.textContent = 'Incorrect password.';
      errorEl.style.display = 'block';
      return;
    }

    setSession({
      firstName,
      lastName,
      fullName: firstName + ' ' + lastName,
      role,
    });
    overlay.remove();
    updateHeaderBadge();
    onSuccess(window.currentUser);
  }
}

// The corner box that already exists on every page doubles as the login
// control. Logged out, it reads "Log In" and opening the login screen.
// Logged in, it shows the real name and role, with a small log out link
// underneath.
function updateHeaderBadge() {
  const authorName = (window.currentUser && window.currentUser.fullName) ? window.currentUser.fullName : '';
  const authorInput = document.getElementById('author');
  if (authorInput) authorInput.value = authorName;
  const authorField = document.getElementById('authorField');
  if (authorField) authorField.value = authorName;
  if (typeof state !== 'undefined' && state && 'author' in state) {
    state.author = authorName;
  }

  if (window.currentUser && window.currentUser.role) {
    if (typeof loadMyLexiconEntries === 'function') loadMyLexiconEntries();
    if (typeof loadMyObservations === 'function') loadMyObservations();
  }

  const badge = document.getElementById('headerUser');
  if (!badge) return;

  const parent = badge.parentElement;
  const existingLogout = document.getElementById('authLogoutLink');
  if (existingLogout) existingLogout.remove();

  if (window.currentUser && window.currentUser.role) {
    const roleLabel = window.currentUser.role === 'faculty' ? 'Faculty' : 'Participant';
    badge.textContent = roleLabel + ': ' + window.currentUser.fullName;
    badge.classList.remove('authLoggedOut');
    badge.onclick = null;

    const logoutLink = document.createElement('button');
    logoutLink.type = 'button';
    logoutLink.id = 'authLogoutLink';
    logoutLink.textContent = 'Log out';
    logoutLink.addEventListener('click', clearSession);
    if (parent) parent.appendChild(logoutLink);
  } else {
    badge.textContent = 'Log In';
    badge.classList.add('authLoggedOut');
    badge.onclick = () => showGate(() => {});
  }
}

(function initAuth() {
  const session = getSession();
  if (session && session.role) {
    window.currentUser = session;
  }
  document.addEventListener('DOMContentLoaded', updateHeaderBadge);
})();
