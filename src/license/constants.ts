/**
 * Embedded RSA public key for license verification.
 * SPKI format (BEGIN PUBLIC KEY) is the standard format compatible with Node.js crypto.
 */
export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Z3qX2BTLS4e7C7hL5pN
1Z7vX3QJ9K8mN4pO2R5tS6uV7wYx8zA9bC0dD1eF2gH3iJ4kL5mN6oP7qR8sT9uV
0wX1yZ2a3B4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ6a7B8cD9eF0gH1iJ2k
L3mN4oP5qR6sT7uV8wX9yZ0a1B2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4a
5B6cD7eF8gH9iJ0kL1mN2oP3qR4sT5uV6wX7yZ8a9B0cD1eF2gH3iJ4kL5mN6oP7
qR8sT9uV0wXIdQIDAQAB
-----END PUBLIC KEY-----`;

// License file search paths (in order of priority)
export const LICENSE_PATHS = [
  './license.json',
  '~/.orbit/license.json',
];

// Install time tracking file
export const INSTALL_TIME_FILE = '.install-time';
