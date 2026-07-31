const crypto = require('crypto');
const express = require('express');
const basicAuth = require('express-basic-auth');

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GRANTED_SCOPES = 'create update';

/** @type {Map<string, { codeChallenge: string, method: string, redirectUri: string, clientId: string, scope: string, me: string, expiresAt: number }>} */
const authCodes = new Map();

/** @type {Map<string, { scope: string, me: string, expiresAt: number }>} */
const accessTokens = new Map();

/**
 * Normalize a URL for IndieAuth identity comparison.
 * @param {string} url
 * @returns {string}
 */
function normalizeIdentityUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    let pathname = parsed.pathname || '/';
    if (!pathname.endsWith('/')) {
      pathname += '/';
    }
    parsed.pathname = pathname;
    return parsed.href;
  } catch {
    return String(url || '').trim();
  }
}

/**
 * Verify PKCE S256 code_verifier against stored code_challenge.
 * @param {string} verifier
 * @param {string} challenge
 * @returns {boolean}
 */
function verifyPkceS256(verifier, challenge) {
  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  return digest === challenge;
}

/**
 * Remove expired auth codes and access tokens.
 */
function purgeExpiredTokens() {
  const now = Date.now();
  for (const [key, value] of authCodes.entries()) {
    if (value.expiresAt <= now) {
      authCodes.delete(key);
    }
  }
  for (const [key, value] of accessTokens.entries()) {
    if (value.expiresAt <= now) {
      accessTokens.delete(key);
    }
  }
}

/**
 * Parse Bearer or form access_token from a request.
 * @param {import('express').Request} req
 * @returns {{ token: string, record: { scope: string, me: string } } | null}
 */
function getAccessTokenFromRequest(req) {
  purgeExpiredTokens();

  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    token = authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  if (!token && req.body && typeof req.body.access_token === 'string') {
    token = req.body.access_token.trim();
  }
  if (!token && req.query && typeof req.query.access_token === 'string') {
    token = req.query.access_token.trim();
  }
  if (!token) {
    return null;
  }

  const record = accessTokens.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    if (record) {
      accessTokens.delete(token);
    }
    return null;
  }
  return { token, record };
}

/**
 * Return true when the token record includes a Micropub scope.
 * @param {{ scope: string }} record
 * @param {string} requiredScope
 * @returns {boolean}
 */
function tokenHasScope(record, requiredScope) {
  const scopes = String(record.scope || '').split(/\s+/).filter(Boolean);
  return scopes.includes(requiredScope);
}

/**
 * Send a JSON OAuth-style error response.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} error
 * @param {string} [description]
 */
function oauthError(res, status, error, description) {
  const body = { error };
  if (description) {
    body.error_description = description;
  }
  return res.status(status).json(body);
}

/**
 * Validate authorization request query parameters.
 * @param {import('express').Request} req
 * @param {string} me
 * @returns {string | null} error description
 */
function validateAuthorizeRequest(req, me) {
  const {
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  } = req.query;

  if (responseType !== 'code') {
    return 'response_type must be "code"';
  }
  if (!clientId || typeof clientId !== 'string') {
    return 'client_id is required';
  }
  if (!redirectUri || typeof redirectUri !== 'string') {
    return 'redirect_uri is required';
  }
  if (!state || typeof state !== 'string') {
    return 'state is required';
  }
  if (!codeChallenge || typeof codeChallenge !== 'string') {
    return 'code_challenge is required';
  }
  if (codeChallengeMethod !== 'S256') {
    return 'code_challenge_method must be S256';
  }

  const requestMe = req.query.me;
  if (requestMe && normalizeIdentityUrl(String(requestMe)) !== normalizeIdentityUrl(me)) {
    return 'me does not match this site';
  }

  try {
    // eslint-disable-next-line no-new
    new URL(String(redirectUri));
  } catch {
    return 'redirect_uri is invalid';
  }

  return null;
}

/**
 * Build redirect URL with authorization code.
 * @param {string} redirectUri
 * @param {string} code
 * @param {string} state
 * @returns {string}
 */
function buildRedirectWithCode(redirectUri, code, state) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.href;
}

/**
 * Create Express router for IndieAuth endpoints.
 * @param {{ me: string, users: Record<string, string>, siteName: string, rootUrl: string }} options
 * @returns {import('express').Router}
 */
function createIndieAuthRouter(options) {
  const router = express.Router();
  const auth = basicAuth({
    users: options.users,
    challenge: true,
  });

  router.use(express.urlencoded({ extended: false }));

  /**
   * Issue an authorization code and redirect back to the client.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function issueAuthorizationCode(req, res) {
    const validationError = validateAuthorizeRequest(req, options.me);
    if (validationError) {
      return oauthError(res, 400, 'invalid_request', validationError);
    }

    const redirectUri = String(req.query.redirect_uri);
    const clientId = String(req.query.client_id);
    const state = String(req.query.state);
    const codeChallenge = String(req.query.code_challenge);
    const codeChallengeMethod = String(req.query.code_challenge_method);

    const code = crypto.randomBytes(32).toString('hex');
    authCodes.set(code, {
      codeChallenge,
      method: codeChallengeMethod,
      redirectUri,
      clientId,
      scope: GRANTED_SCOPES,
      me: options.me,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    return res.redirect(buildRedirectWithCode(redirectUri, code, state));
  }

  router.get('/authorize', auth, (req, res) => {
    const validationError = validateAuthorizeRequest(req, options.me);
    if (validationError) {
      return oauthError(res, 400, 'invalid_request', validationError);
    }

    if (req.query.approved === '1') {
      return issueAuthorizationCode(req, res);
    }

    return res.render('auth/consent', {
      layout: false,
      siteName: options.siteName,
      clientId: req.query.client_id,
      scopes: GRANTED_SCOPES,
      rootUrl: options.rootUrl,
      oauthQuery: new URLSearchParams(
        Object.entries(req.query).reduce((acc, [key, value]) => {
          if (typeof value === 'string') {
            acc[key] = value;
          }
          return acc;
        }, {})
      ).toString(),
    });
  });

  router.post('/authorize', auth, (req, res) => {
    const merged = { ...req.query, ...req.body };
    req.query = merged;

    const validationError = validateAuthorizeRequest(req, options.me);
    if (validationError) {
      return oauthError(res, 400, 'invalid_request', validationError);
    }

    return issueAuthorizationCode(req, res);
  });

  router.post('/token', (req, res) => {
    purgeExpiredTokens();

    const grantType = req.body.grant_type;
    if (grantType !== 'authorization_code') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code is supported');
    }

    const code = req.body.code;
    const redirectUri = req.body.redirect_uri;
    const clientId = req.body.client_id;
    const codeVerifier = req.body.code_verifier;

    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return oauthError(res, 400, 'invalid_request', 'Missing required token parameters');
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt <= Date.now()) {
      authCodes.delete(code);
      return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired');
    }

    if (stored.redirectUri !== redirectUri || stored.clientId !== clientId) {
      return oauthError(res, 400, 'invalid_grant', 'redirect_uri or client_id does not match');
    }

    if (stored.method !== 'S256' || !verifyPkceS256(codeVerifier, stored.codeChallenge)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    }

    authCodes.delete(code);

    const accessToken = crypto.randomBytes(32).toString('hex');
    accessTokens.set(accessToken, {
      scope: stored.scope,
      me: stored.me,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      scope: stored.scope,
      me: stored.me,
    });
  });

  return router;
}

module.exports = {
  createIndieAuthRouter,
  getAccessTokenFromRequest,
  tokenHasScope,
};
