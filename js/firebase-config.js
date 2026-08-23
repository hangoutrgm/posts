import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyAEQxuQU23L269MOfZCRKaYO4rHZpDDlng",
    authDomain: "hangoutposts.firebaseapp.com",
    databaseURL: "https://hangoutposts-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "hangoutposts",
    storageBucket: "hangoutposts.firebasestorage.app",
    messagingSenderId: "622286344359",
    appId: "1:622286344359:web:6d2fc33137ea0422be0b82",
    measurementId: "G-4G3FCMJNG5"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// Enable persistent IndexedDB cache — serves data from browser cache first,
// only charges Firestore reads for documents that actually changed since last visit.
// persistentMultipleTabManager allows the cache to work correctly across multiple tabs.
export const fsdb = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

export const cloudinaryConfig = {
    cloudName: "rlnbst7h",
    uploadPreset: "hangout-images"
};