/**
 * Embedded RSA public key for license verification.
 * SPKI format (BEGIN PUBLIC KEY) is the standard format compatible with Node.js crypto.
 */
export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq9/1P61rqID6rmQnImGl
FE/ulRwuiMwQGWE5chkqyb/lZhEXg3MyHGCBD7SLIiQmjhSDNk18P32mgvOivjwE
g2gdzDm5c4OlPKZ/MUXqZ1/Vpy7alE5fx/wViP93PXWMvS/JzO/BIm2tkJ2mwfbn
MJdy24dmWEkIcWNmFHULjSSn6kMk1WGUyotvX2XMaxrOMvh6O15sBRhTmOV03fUg
+EIx1ewVsyYMEDnq8j/3+eydA+JU4h1+zvlKn0Dq4KJ6DAGsGZg3e4h6sTqui8pk
pOCCZY5VUyFf1F7diGsKs6c3nQpYqIwRmGMffL6P2gCx0254t1/qhb48TmLkbfXp
swIDAQAB
-----END PUBLIC KEY-----`;

// License file search paths (in order of priority)
export const LICENSE_PATHS = [
  './license.json',
  '~/.orbit/license.json',
];

// Install time tracking file
export const INSTALL_TIME_FILE = '.install-time';
