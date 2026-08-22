import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Primary Firebase Project (hangoutrgm)
const firebaseConfig = {
    apiKey: "AIzaSyBhlpAvnVX9le1okdbbKKotPET8D2sveR4",
    authDomain: "hangoutrgm.firebaseapp.com",
    databaseURL: "https://hangoutrgm-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "hangoutrgm",
    storageBucket: "hangoutrgm.firebasestorage.app",
    messagingSenderId: "786502979018",
    appId: "1:786502979018:web:eff3d2fd9fee242c749333"
};

// Secondary Firebase Project (hangoutrgm2) - for splitting community posts load
const firebaseConfig2 = {
    apiKey: "AIzaSyD4oGEV6owQJIxYJJTsOD9JWMtkLKqkMm4",
    authDomain: "hangoutrgm2.firebaseapp.com",
    databaseURL: "https://hangoutrgm2-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "hangoutrgm2",
    storageBucket: "hangoutrgm2.firebasestorage.app",
    messagingSenderId: "26550011259",
    appId: "1:26550011259:web:47b2c083e8f8298c8629de"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// Primary Firestore instance (fsdb)
export const fsdb = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

// Secondary Firebase App and Firestore instance (fsdb2)
export const app2 = initializeApp(firebaseConfig2, "hangoutrgm2");
export const fsdb2 = initializeFirestore(app2, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

// Map to track which Firestore database holds a specific post (1 or 2)
window._postDbMap = window._postDbMap || new Map();

/**
 * Returns the Firestore instance for a given source ID (1 or 2).
 */
export function getFirestoreBySource(source) {
    return (source === 2 || source === '2') ? fsdb2 : fsdb;
}

/**
 * Resolves the appropriate Firestore instance for a postId based on cache, memory, or explicit source.
 */
export function getFirestoreForPost(postId, explicitSource) {
    if (explicitSource === 1 || explicitSource === 2 || explicitSource === '1' || explicitSource === '2') {
        return getFirestoreBySource(explicitSource);
    }
    if (window._postDbMap && window._postDbMap.has(postId)) {
        return getFirestoreBySource(window._postDbMap.get(postId));
    }
    if (Array.isArray(window.allPosts)) {
        const found = window.allPosts.find(p => p && p.id === postId);
        if (found && found._dbSource) {
            window._postDbMap.set(postId, found._dbSource);
            return getFirestoreBySource(found._dbSource);
        }
    }
    if (window.isolatedPostData && window.isolatedPostData.id === postId && window.isolatedPostData._dbSource) {
        window._postDbMap.set(postId, window.isolatedPostData._dbSource);
        return getFirestoreBySource(window.isolatedPostData._dbSource);
    }
    return fsdb; // Default to primary
}

/**
 * Returns a DocumentReference pointing to the correct Firestore database for a post.
 */
export function getPostDocRef(postId, explicitSource) {
    const targetFs = getFirestoreForPost(postId, explicitSource);
    return doc(targetFs, 'community_posts', postId);
}

/**
 * Round-robin selector for new posts: alternates between 1 and 2 in localStorage.
 */
export function getRoundRobinFsdb() {
    const lastTarget = localStorage.getItem('hangout_fs_target') || '2';
    const nextTarget = (lastTarget === '1') ? '2' : '1';
    localStorage.setItem('hangout_fs_target', nextTarget);
    const dbSource = parseInt(nextTarget, 10);
    return {
        fsdb: dbSource === 2 ? fsdb2 : fsdb,
        dbSource: dbSource
    };
}

// Attach utilities to window for global access
window.fsdb = fsdb;
window.fsdb2 = fsdb2;
window.getFirestoreBySource = getFirestoreBySource;
window.getFirestoreForPost = getFirestoreForPost;
window.getPostDocRef = getPostDocRef;
window.getRoundRobinFsdb = getRoundRobinFsdb;

export const cloudinaryConfig = {
    cloudName: "rlnbst7h",
    uploadPreset: "hangout-images"
};