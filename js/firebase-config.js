// Firebase initialization for The Sea Ranch as Prototype
//
// This config is not a secret. Firebase client config identifies which
// project to talk to, it does not grant access on its own, that's what
// Firestore security rules are for (set up separately, once real data is
// flowing). It is fine for this file to sit in the public repo.
//
// This uses the Firebase "compat" libraries (the firebase.* global style)
// rather than the modern modular SDK, since the rest of this codebase is
// plain scripts, not ES modules. The <script> tags this depends on must be
// loaded before this file, see the loading order note at the bottom.

const firebaseConfig = {
  apiKey: "AIzaSyCKzWYifvsFFxsAEXmc0o2fwlqy3UbnDeQ",
  authDomain: "sea-ranch-collective-score.firebaseapp.com",
  projectId: "sea-ranch-collective-score",
  storageBucket: "sea-ranch-collective-score.firebasestorage.app",
  messagingSenderId: "241774248297",
  appId: "1:241774248297:web:13f1d42558656c90fbbdf8"
};

firebase.initializeApp(firebaseConfig);

// Exposed globally so any page's script can reach these without each one
// re-initializing Firebase itself.
window.db = firebase.firestore();

/*
  LOADING ORDER, this file depends on the Firebase compat libraries already
  being loaded. In each HTML page that needs Firebase, add these two script
  tags, in this exact order, before this file:

  <script src="https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore-compat.js"></script>
  <script src="js/firebase-config.js"></script>
*/
