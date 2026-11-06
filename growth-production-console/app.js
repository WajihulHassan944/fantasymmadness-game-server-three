/* FANTASY MMADNESS Growth Engine back office (isolated staging).
 * Talks only to the same-origin /api/growth/admin API. Every value from the
 * API is inserted as text (never as HTML); email previews render in a
 * sandboxed iframe without scripts. */
(function () {
  'use strict';
  var API = '/api/growth';
  var PRODUCTION = document.documentElement.getAttribute('data-production-preparation') === 'true';
  var INTEGRATED = document.documentElement.getAttribute('data-integrated-preview') === 'true';
  var TOKEN_KEY = PRODUCTION ? 'fmmGrowthProductionPreparationToken' : INTEGRATED ? 'fmmGrowthSocialOAuthPreviewToken' : 'fmmGrowthConsoleToken';
  var SPORTS = ['boxing', 'mma-ufc', 'kickboxing', 'bare-knuckle', 'pro-wrestling'];
  var SPORT_NAMES = { boxing: 'Boxing', 'mma-ufc': 'MMA / UFC', kickboxing: 'Kickboxing', 'bare-knuckle': 'Bare-Knuckle', 'pro-wrestling': 'Pro Wrestling' };
  var DEPT_NAMES = { audience: 'Audience research', marketing: 'Marketing', 'public-relations': 'Public relations', 'affiliate-recruitment': 'Affiliate recruitment', performance: 'Performance' };
  var KIND_NAMES = { marketing: 'Marketing post', pr: 'PR email', affiliate: 'Affiliate invite' };
  var STATUS = {
    needs_owner_review: ['Awaiting your approval', 'warn', '●'], approved: ['Approved', 'good', '✓'], delivered: ['Delivered', 'good', '✓'],
    published: ['Published', 'good', '✓'], rejected: ['Rejected', 'bad', '✕'], suppressed: ['Blocked: opted out', 'bad', '⦸'],
    delivery_failed: ['Delivery failed', 'bad', '!'], completed: ['Completed', 'good', '✓'], failed: ['Failed', 'bad', '!'],
    stale: ['Interrupted', 'warn', '!'], claimed: ['Running', 'info', '◔'], running: ['Running', 'info', '◔'], pending: ['Waiting', 'info', '◔'],
    retry: ['Will retry', 'warn', '↻'], open: ['Open', 'bad', '!'], acknowledged: ['Acknowledged', 'good', '✓'],
    scheduled: ['Scheduled', 'info', '◔'], publishing: ['Publishing…', 'info', '◔'], held: ['Held: channel not connected', 'warn', '⏸'], cancelled: ['Cancelled', '', '✕'],
    needs_check: ['Check the channel', 'bad', '!'], invite_prepared: ['Invitation approved', 'info', '✉'], invited: ['Invited', 'info', '✉'], active: ['Active affiliate', 'good', '✓'], paused: ['Paused', 'warn', '⏸'], declined: ['Declined', '', '✕'],
  };
  var NAV = [
    ['overview', 'Overview', '⌂'], ['approvals', 'Campaign Approvals', '✓'], ['marketing', 'Marketing', '📣'], ['pr', 'Public Relations', '📰'],
    ['affiliates', 'Affiliate Recruitment', '🤝'], ['publishing', 'Publishing', '📅'], ['automation', 'Automation', '⚙'], ['analytics', 'Analytics', '📊'], ['revenue', 'Revenue Attribution', '$'], ['connections', 'Connections', '🔌'],
  ];
  var state = { pendingCount: null, alertCount: null }; var renders = 0;
  // Embedded in the FANTASY MMADNESS admin back office: the admin site provides the
  // navigation, so the console hides its own sidebar and reports the current section.
  var EMBEDDED = /[?&]embed=1(&|$)/.test(location.search) && window.parent !== window;
  if (EMBEDDED) document.documentElement.classList.add('embedded');
  // Messages to the back office: { type:'fmm-growth-console', section, signedIn, event?, reason?, expiresAt? }
  // event: 'session-ready' (session accepted; expiresAt in ms), 'session-expired' (ended/revoked; reason),
  // 'signed-out' (signed out here or at the back office's request).
  function tellParent(section, extra) { if (EMBEDDED) { try { var parentOrigin = (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) || '*'; var m = { type: 'fmm-growth-console', section: section, signedIn: Boolean(token()) }; if (extra) for (var k in extra) m[k] = extra[k]; window.parent.postMessage(m, parentOrigin); } catch (e) { /* ignore */ } } }

  // ---------- tiny DOM helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'testid') el.setAttribute('data-testid', v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function fmtNum(n) { return n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'); }
  function money(c) { return '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function sport(g) { return SPORT_NAMES[g] || g || '—'; }
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso); if (isNaN(d)) return String(iso);
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    var rel = mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : mins < 1440 ? Math.round(mins / 60) + ' hr ago' : Math.round(mins / 1440) === 1 ? '1 day ago' : Math.round(mins / 1440) + ' days ago';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (' + rel + ')';
  }
  function expiryWhen(iso) {
    if(!iso)return 'unknown';var d=new Date(iso);if(isNaN(d))return 'unknown';
    return d.toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})+' ['+Intl.DateTimeFormat().resolvedOptions().timeZone+']';
  }
  function chip(status) {
    var s = STATUS[status] || [status || 'unknown', '', ''];
    return h('span', { class: 'chip ' + s[1], testid: 'status-chip' }, s[2] ? h('span', { 'aria-hidden': 'true', text: s[2] }) : null, s[0]);
  }
  function kindChip(kind) { return h('span', { class: 'chip kind', text: KIND_NAMES[kind] || kind }); }
  function sportSelect(value, onchange, includeAll) {
    var s = h('select', { onchange: function () { onchange(s.value); }, 'aria-label': 'Sport' });
    if (includeAll !== false) s.appendChild(h('option', { value: '', text: 'All sports' }));
    SPORTS.forEach(function (g) { s.appendChild(h('option', { value: g, text: sport(g) })); });
    s.value = value || ''; return s;
  }
  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind || ''), testid: 'toast', text: msg });
    document.getElementById('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }
  function friendly(reason) {
    if (/^duplicate_of_/.test(String(reason || ''))) return 'The same post (same text and image) is already scheduled or was posted in the last 7 days.';
    var map = {
      affiliate_not_found: 'That affiliate was not found.', affiliate_is_not_active_with_a_live_affiliate_id: 'Only active affiliates with a linked live affiliate ID can be credited.', this_channel_has_no_link_to_credit: 'this channel has no link to credit',
      live_test_not_authorized_by_owner: 'The controlled live test has not been authorized yet.', type_POST_LIVE_to_confirm: 'Type POST LIVE to confirm.', live_test_is_for_facebook_or_instagram: 'The live test is for Facebook or Instagram.',
      the_live_test_for_this_channel_was_already_used: 'The live test for this channel has already been used.', approve_the_campaign_first: 'Approve the campaign first.', only_verified_fight_campaigns: 'Only verified fight campaigns can be posted.',
      meta_did_not_publish: 'Meta did not publish the post. Nothing went live; see the details.', publishing_is_paused: 'Publishing is paused.', no_post_for_this_channel: 'There is no post for this channel.',
      encryption_key_not_configured: 'Stored sign-in encryption is not set up yet.', app_id_must_be_digits: 'The App ID is a number (digits only).', login_configuration_id_must_be_digits: 'The login configuration ID is a number (digits only).', app_secret_must_be_32_characters: 'The App Secret is 32 letters and numbers.',
      meta_rejected_app_id_or_secret: 'Meta did not accept that App ID and App Secret. Copy them again from the Meta app’s Basic settings.', meta_unreachable_try_again: 'Meta could not be reached. Try again in a minute.',
      meta_app_not_set_up: 'Enter the Meta app’s App ID and App Secret first.', authorize_with_meta_first: 'Connect with Meta first.', confirm_this_is_the_business_page: 'Tick the box to confirm this is the FANTASY MMADNESS business Page.',
      page_not_in_your_authorized_list: 'That Page is not in the list Meta authorized.', you_cannot_post_on_this_page: 'Your Facebook account cannot post on this Page.', no_instagram_professional_account_is_linked_to_this_page: 'No Instagram professional account is linked to this Page.',
      not_the_expected_business_page: 'This is not the expected FANTASY MMADNESS Page.', not_the_expected_instagram_account: 'This is not the expected FANTASY MMADNESS Instagram account.', meta_could_not_confirm_the_page: 'Meta could not confirm the Page right now. Try again.',
      instagram_link_changed_reconnect: 'The Instagram account linked to this Page changed. Connect again.', reconnect_required: 'Please connect again.',
      not_found_or_not_awaiting_review: 'This item is no longer waiting for approval (it may have been handled already). The list has been refreshed.',
      not_found_or_already_sent: 'This item can no longer be rejected (it may already be delivered). The list has been refreshed.',
      only_drafts_awaiting_review_can_be_edited: 'Only items awaiting approval can be edited.',
      only_approved_marketing_posts_can_be_marked_published: 'Only approved marketing posts can be marked as published.',
      post_link_must_start_with_https: 'The post link must start with https://',
      consent_basis_required: 'Please describe how this contact agreed to be contacted (consent basis).',
      kind_must_be_pr_or_affiliate: 'Choose PR or affiliate.', contact_opted_out: 'This contact has opted out and cannot be contacted.',
      invalid_contact: 'That email address is not valid.', verified_contact_required: 'That email address is not valid.', prospect_not_found: 'Prospect not found.', draft_already_exists: 'An outreach draft for this prospect already exists — check Campaign Approvals.',
      valid_email_required: 'Please enter a valid email address.',
      approve_the_campaign_before_scheduling: 'Approve the campaign first, then schedule it.', time_is_in_the_past: 'Pick a time in the future.', time_is_after_the_fight: 'Pick a time before the fight ends.',
      channel_needs_a_fight_poster_image: 'needs a fight poster image', choose_at_least_one_valid_channel: 'Choose at least one channel.', confirm_the_post_is_not_already_live: 'First check the channel and confirm the post is not already live.',
      live_affiliate_id_required: 'Enter the affiliate’s live ID (24 characters, from the live Affiliate back office).', live_affiliate_id_already_linked: 'That live affiliate ID is already linked to another creator.',
      only_scheduled_held_or_failed_posts_can_be_cancelled: 'This post can no longer be cancelled.',
      edit_failed_safeguard: 'Blocked by the campaign safeguard. A fight post must keep both fighter names and the contest link, and must not mention prizes, money, betting, titles that are not in the contest, or podcast/media names.',
      contest_no_longer_open_or_verified: 'This fight’s contest is no longer open and verified, so the campaign cannot be approved. It will be withdrawn automatically.',
      fight_details_changed_use_the_corrected_campaign: 'The fight details changed since this campaign was prepared. Use the corrected campaign instead.',
      contest_feed_unreachable_try_again: 'Could not reach the FANTASY MMADNESS contest list to re-check this fight. Please try again in a minute.',
      not_based_on_a_verified_contest: 'This campaign is not based on a verified fight contest and cannot be approved.',
      campaign_failed_safeguard: 'This campaign failed the safety check and cannot be approved.', headline_required: 'The headline cannot be empty.', text_required: 'The text cannot be empty.', subject_required: 'The subject cannot be empty.',
    };
    return map[reason] || (reason ? String(reason).replace(/_/g, ' ') : 'Something went wrong.');
  }

  // ---------- API ----------
  var expiryTimer = null;
  // Revoke this session on the server (best effort), forget it here, and show the sign-in.
  function signOut(message) {
    var t = token();
    setToken('');
    var done = false; var finish = function () { if (done) return; done = true; renderLogin(message, { event: 'signed-out' }); };
    if (!t) return finish();
    // tell the back office only after the server has revoked the session (it may remove this frame)
    try { fetch(API + '/admin/logout', { method: 'POST', cache: 'no-store', keepalive: true, headers: { Authorization: 'Bearer ' + t } }).then(finish, finish); } catch (e) { finish(); }
    setTimeout(finish, 3000);
  }
  function scheduleExpiry(expMs) {
    clearTimeout(expiryTimer);
    if (!expMs) return;
    expiryTimer = setTimeout(function () { setToken(''); renderLogin('Your Growth Engine session ended. It renews automatically from your administrator sign-in.', { event: 'session-expired', reason: 'expired' }); }, Math.max(0, Math.min(expMs - Date.now(), 2147483000)));
  }
  var productionToken = ''; // Memory only: embedded browsers may block all third-party storage.
  function token() { if(PRODUCTION)return productionToken; try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { if(PRODUCTION){productionToken=t||'';return;} try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }
  function api(method, path, body) {
    if (PRODUCTION && method !== 'GET' && ['/admin/logout','/admin/autonomy/stop'].indexOf(path) === -1) return Promise.reject(new Error('Production preparation only. Campaign release, delivery and credential changes require separate authorization.'));
    var headers = { Accept: 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
          if (r.status === 401 && path !== '/admin/login') { setToken(''); renderLogin('Your session ended. Please sign in again.', { event: 'session-expired', reason: (j && j.reason) || 'session_invalid' }); throw Object.assign(new Error('signed_out'), { silent: true }); }
          if (!r.ok) { var err = new Error((j && (j.message || j.reason)) || ('Request failed (' + r.status + ')')); err.status = r.status; err.reason = j && j.reason; err.body = j; throw err; }
          return j || {};
        });
      });
  }
  function explain(e) { var d = e && e.body && Array.isArray(e.body.details) && e.body.details.length ? ' (' + e.body.details.map(function (x) { return String(x).replace(/_/g, ' '); }).join('; ') + ')' : ''; return (e && e.reason ? friendly(e.reason) : (e && e.message) || 'Request failed') + d; }
  function fail(e) { if (e && e.silent) return; toast(explain(e), 'bad'); }

  // ---------- modal ----------
  function modal(opts) {
    return new Promise(function (resolve) {
      var err = h('div', { class: 'error', role: 'alert' });
      var confirmBtn = h('button', { class: 'btn ' + (opts.confirmClass || 'primary'), testid: 'modal-confirm', text: opts.confirmLabel || 'Confirm' });
      var cancelBtn = h('button', { class: 'btn', testid: 'modal-cancel', text: opts.cancelLabel || 'Cancel' });
      var back = h('div', { class: 'modal-back', testid: 'modal' },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
          h('header', { text: opts.title }), h('div', { class: 'content' }, opts.body || null, err),
          h('footer', null, opts.hideCancel ? null : cancelBtn, confirmBtn)));
      function close(v) { back.remove(); document.removeEventListener('keydown', esc); resolve(v); }
      function esc(e) { if (e.key === 'Escape') close(null); }
      document.addEventListener('keydown', esc);
      cancelBtn.addEventListener('click', function () { close(null); });
      confirmBtn.addEventListener('click', function () {
        if (!opts.onConfirm) return close(true);
        confirmBtn.disabled = true; err.textContent = '';
        Promise.resolve().then(opts.onConfirm).then(function (v) { close(v === undefined ? true : v); })
          .catch(function (e) { confirmBtn.disabled = false; if (!e || !e.silent) err.textContent = explain(e); });
      });
      document.body.appendChild(back);
        /* BEGIN authorized 2026-11-06 dialog visibility. */
        tellParent(parse().name, {event:'dialog-open'});
        /* END authorized 2026-11-06 dialog visibility. */
      var first = back.querySelector('input,textarea,select'); (first || confirmBtn).focus();
    });
  }
  function emailPreview(html) {
    // Render a safe, readable email in the existing console. Browser security
    // policies block nested about:srcdoc frames on some hosting/browser paths.
    // Do not use innerHTML or append untrusted nodes: copy ONLY approved tags
    // and text into newly created elements. No scripts, CSS, event handlers,
    // images, forms, iframes or remote resources can reach the console.
    var panel = h('div', { class: 'preview email-preview-safe', role: 'region', 'aria-label': 'Read-only email preview', testid: 'email-preview' });
    var parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var tags = { P: 1, DIV: 1, SPAN: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, BR: 1,
      H1: 1, H2: 1, H3: 1, H4: 1, UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1,
      TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1, HR: 1, SMALL: 1, A: 1 };
    var drop = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, MATH: 1,
      FORM: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, PICTURE: 1 };
    var copied = 0;
    function approvedPreviewLink(raw) {
      if (!raw || typeof raw !== 'string') return null;
      try {
        var u = new URL(raw, 'https://www.fantasymmadness.com/');
        if (u.protocol !== 'https:' || (u.hostname !== 'fantasymmadness.com' && u.hostname !== 'www.fantasymmadness.com')) return null;
        if (u.username || u.password || u.port) return null;
        return u.href;
      } catch (_) { return null; }
    }
    function safeCopy(node, into, depth) {
      if (depth > 45 || copied++ > 10000) return;
      if (node.nodeType === 3) { into.appendChild(document.createTextNode(node.nodeValue || '')); return; }
      if (node.nodeType !== 1 || drop[node.tagName]) return;
      if (!tags[node.tagName]) {
        // Unrecognized containers are flattened, not trusted or executed.
        if (node.tagName === 'IMG' || node.tagName === 'LINK' || node.tagName === 'META') return;
        Array.from(node.childNodes).forEach(function (n) { safeCopy(n, into, depth + 1); });
        return;
      }
      var item = document.createElement(node.tagName.toLowerCase());
      // Only verified FANTASY MMADNESS HTTPS links are clickable in this
      // staging preview. Do not restore styles, event handlers or remote URLs.
      if (node.tagName === 'A') {
        var href = approvedPreviewLink(node.getAttribute('href'));
        if (href) {
          item.setAttribute('href', href);
          item.setAttribute('target', '_blank');
          item.setAttribute('rel', 'noopener noreferrer');
          if (/^\s*See the affiliate program\s*$/i.test(node.textContent || '')) item.className = 'email-preview-cta';
        }
      }
      Array.from(node.childNodes).forEach(function (n) { safeCopy(n, item, depth + 1); });
      into.appendChild(item);
    }
    if (parsed.body) Array.from(parsed.body.childNodes).forEach(function (n) { safeCopy(n, panel, 0); });
    if (!panel.textContent.trim()) panel.appendChild(h('p', { text: 'This email has no readable preview content.' }));
    return panel;
  }
  function copyText(text) {
    var done = function () { toast('Copied to clipboard. Paste it into the social account.', 'good'); };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    fallbackCopy(text); done(); return Promise.resolve();
  }
  function fallbackCopy(text) { var t = h('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } t.remove(); }

  // ---------- login ----------
  function renderLogin(message, signal) {
    if (PRODUCTION) { clearTimeout(expiryTimer); tellParent('signin', signal); clear(document.getElementById('app')).appendChild(h('div',{class:'login-wrap'},h('div',{class:'login'},h('div',{class:'logo',text:'FANTASY MMADNESS'}),h('h1',{text:'Growth Engine back office'}),h('p',{text:message || 'Waiting for your existing administrator session.'})))); return; }
    if (INTEGRATED) return renderIntegratedLogin(message, signal);
    clearTimeout(expiryTimer);
    var app = clear(document.getElementById('app')); tellParent('signin', signal);
    var pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, testid: 'login-password' });
    var errBox = h('p', { class: 'error', role: 'alert', testid: 'login-error', text: message || '' });
    var btn = h('button', { class: 'btn primary', type: 'submit', testid: 'login-submit', text: 'Sign in' });
    var form = h('form', { onsubmit: function (e) {
      e.preventDefault(); btn.disabled = true; errBox.textContent = '';
      api('POST', '/admin/login', { password: pw.value }).then(function (r) { setToken(r.token); location.hash = location.hash || '#/overview'; boot(); })
        .catch(function (e2) { errBox.textContent = e2.message || 'Sign-in failed'; btn.disabled = false; pw.select(); });
    } },
      h('label', { class: 'field', for: 'pw' }, h('span', { text: 'Owner password' }), pw), errBox, btn);
    add(app, h('div', { class: 'login-wrap' }, h('div', { class: 'login', testid: 'login' },
      h('div', { class: 'logo', style: null }, 'FANTASY ', h('b', { text: 'MMADNESS' })),
      h('h1', { text: 'Growth Engine back office' }),
      h('p', { text: 'Staging environment. Nothing here sends email, posts to social media, or touches payments.' }), form)));
    pw.focus();
  }

  // One console and one Preview session: standalone windows only change the cookie context.
  function acceptPreviewSession(value) {
    return fetch(API + '/admin/session', { cache: 'no-store', headers: { Authorization: 'Bearer ' + value } }).then(function (r) {
      if (!r.ok) throw new Error('Administrator session was rejected');
      return r.json();
    }).then(function (s) { setToken(value); state.sessionExpMs = s.exp * 1000; scheduleExpiry(state.sessionExpMs); boot(); });
  }
  function renderIntegratedLogin(message, signal) {
    clearTimeout(expiryTimer); tellParent('signin', signal);
    var app = clear(document.getElementById('app'));
    var notice = h('p', { role: 'status', text: message || (EMBEDDED ? 'Connecting your website administrator session…' : 'Use your normal website administrator account. No separate Growth password is needed.') });
    app.appendChild(h('section', { class: 'card', testid: 'integrated-sign-in' }, h('h1', { text: 'Growth Engine · Administration' }), notice,
      h('button', { class: 'btn primary', text: 'Sign in with FANTASY MMADNESS', onclick: function () {
        var w = window.open('about:blank', 'growth-admin-sign-in');
        if (!w) { notice.textContent = 'Allow the sign-in window and try again.'; return; }
        api('GET', '/social/admin/sign-in').then(function (r) {
          if (!r.configured || !r.url) throw new Error('Website sign-in is not configured');
          var u = new URL(r.url), challenge = Array.from(crypto.getRandomValues(new Uint8Array(32)), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
          var listener = function (e) { if (e.source !== w || e.origin !== u.origin || e.data?.type !== 'fmm-growth-social-session' || e.data.state !== challenge || typeof e.data.token !== 'string' || e.data.token.length > 4096) return; window.removeEventListener('message', listener); acceptPreviewSession(e.data.token).catch(function (err) { notice.textContent = err.message; }); };
          window.addEventListener('message', listener); setTimeout(function () { window.removeEventListener('message', listener); }, 300000);
          u.hash = challenge; w.location = u.href;
        }).catch(function (err) { w.close(); notice.textContent = err.message; });
      } })));
  }
  function secureConnectionsWindow() {
    var challenge = Array.from(crypto.getRandomValues(new Uint8Array(24)), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    var w = window.open(API + '/console?connectionWindow=' + challenge + '#/connections', 'growth-secure-connections');
    if (!w) return toast('Allow the secure Connections window and try again.', 'bad');
    var listener = function (e) { if (e.source !== w || e.origin !== location.origin || e.data?.type !== 'fmm-growth-connection-ready' || e.data.challenge !== challenge) return; w.postMessage({ type: 'fmm-growth-connection-session', challenge: challenge, token: token() }, location.origin); window.removeEventListener('message', listener); };
    window.addEventListener('message', listener); setTimeout(function () { window.removeEventListener('message', listener); }, 60000);
  }
  if (INTEGRATED && window.opener) {
    var connectionChallenge = new URLSearchParams(location.search).get('connectionWindow');
    if (/^[a-f0-9]{48}$/.test(connectionChallenge || '')) {
      var connectionListener = function (e) { if (e.source !== window.opener || e.origin !== location.origin || e.data?.type !== 'fmm-growth-connection-session' || e.data.challenge !== connectionChallenge || typeof e.data.token !== 'string' || e.data.token.length > 4096) return; window.removeEventListener('message', connectionListener); acceptPreviewSession(e.data.token).catch(fail); };
      window.addEventListener('message', connectionListener); window.opener.postMessage({ type: 'fmm-growth-connection-ready', challenge: connectionChallenge }, location.origin);
      setTimeout(function () { window.removeEventListener('message', connectionListener); }, 60000);
    }
  }
  function oauthCards() {
    var card = h('section', { class: 'card', testid: 'verified-oauth-connections' }, h('h2', { text: 'TikTok and X account connections' }), h('p', { text: 'Verified account authorization is separate from publishing. Automatic publishing is disabled.' }));
    api('GET', '/social/connections').then(function (r) {
      r.providers.forEach(function (p) {
        var account = r.connections.find(function (x) { return x.provider === p.provider; });
        var candidate = r.pending.find(function (x) { return x.provider === p.provider; });
        var name = p.provider === 'tiktok' ? 'TikTok' : 'X';
        var box = h('section', { testid: 'oauth-' + p.provider }, h('h3', { text: name }), h('p', { text: 'Status: ' + (account?.status || 'not connected') }), h('p', { class: 'small', text: 'Callback: ' + p.callbackUrl }));
        if (account) box.appendChild(h('p', { text: (account.username ? '@' + account.username + ' · ' : '') + (account.displayName || '') + ' · ID: ' + account.identity }));
        if(account)box.appendChild(h('p',{class:'small',text:'Access expiry: '+expiryWhen(account.tokenExpiresAt)+' · Refresh expiry: '+(account.refreshExpiryKnown?expiryWhen(account.refreshExpiresAt):'provider expiry unknown; not assumed indefinite')+' · Granted scopes: '+((account.grantedScopes||[]).join(', ')||'not yet checked')+(account.reason?' · Action: '+account.reason:'')}));
        if(account)box.appendChild(h('p',{class:account.renewalStatus==='expired'?'banner warn':'small',testid:'renewal-'+p.provider,text:'Access: '+(account.accessStatus||'not yet checked')+' · Renewal: '+(account.renewalStatus||'not yet checked')+(account.renewalStatus==='expired'?' — Access can remain connected, but the expired refresh grant requires account-holder reauthorization before access expires. No token was revoked.':'')+(account.expiryEvidence?.source?' · Expiry source: '+account.expiryEvidence.source:'')}));
        if (p.blockers.length) box.appendChild(h('p', { text: 'Configuration required: ' + p.blockers.join(', ') }));
        box.appendChild(h('button', { class: 'btn primary', disabled: !p.configured, text: 'Connect ' + name, onclick: function () {
          if (EMBEDDED) return secureConnectionsWindow();
          var w = window.open('about:blank', 'growth-' + p.provider); if (w) w.opener = null;
          api('POST', '/social/' + p.provider + '/connect', {}).then(function (x) { if (w) w.location = x.authorizationUrl; else location.assign(x.authorizationUrl); }).catch(function (e) { if (w) w.close(); fail(e); });
        } }));
        if (candidate) {
          box.appendChild(h('p', { text: 'Provider-verified account awaiting your confirmation: ' + candidate.displayName + ' · ' + (candidate.username || '') + ' · ID: ' + candidate.identity }));
          box.appendChild(h('button', { class: 'btn', text: 'Confirm ' + name + ' account', onclick: function () { if (EMBEDDED) return secureConnectionsWindow(); api('POST', '/social/' + p.provider + '/confirm', { candidateId: candidate.candidateId, identity: candidate.identity }).then(route).catch(fail); } }));
        }
        if (account && account.status !== 'disconnected') {
          box.appendChild(h('button', { class: 'btn', disabled: !account.refreshAvailable || account.renewalAvailable === false, text: 'Refresh ' + name + ' token', onclick: function () { api('POST', '/social/' + p.provider + '/refresh', {}).then(route).catch(fail); } }));
          box.appendChild(h('button', { class: 'btn danger', text: 'Disconnect ' + name, onclick: function () { modal({ title: 'Disconnect ' + name + '?', body: h('p', { text: 'This removes stored credentials. Publishing remains disabled.' }), onConfirm: function () { return api('POST', '/social/' + p.provider + '/disconnect', {}); } }).then(function (yes) { if (yes) route(); }).catch(fail); } }));
        }
        card.appendChild(box);
      });
      card.appendChild(h('button', { class: 'btn small', text: 'Refresh connection status', onclick: route }));
    }).catch(function (e) { card.appendChild(h('p', { role: 'alert', text: 'Connection status unavailable: ' + e.message })); });
    return card;
  }

  // ---------- shell ----------
  function shell(active) {
    var app = clear(document.getElementById('app'));
    var nav = h('nav', { class: 'sidenav', 'aria-label': 'Sections' });
    NAV.forEach(function (n) {
      var badge = null;
      if (n[0] === 'approvals' && state.pendingCount !== null) badge = h('span', { class: 'badge' + (state.pendingCount ? '' : ' zero'), testid: 'nav-pending', text: String(state.pendingCount) });
      if (n[0] === 'automation' && state.alertCount) badge = h('span', { class: 'badge', testid: 'nav-alerts', text: String(state.alertCount) });
      nav.appendChild(h('a', { href: '#/' + n[0], class: n[0] === active ? 'active' : '', testid: 'nav-' + n[0], 'aria-current': n[0] === active ? 'page' : null },
        h('span', { class: 'ico', 'aria-hidden': 'true', text: n[2] }), n[1], badge));
    });
    var main = h('main', { id: 'main', testid: 'page-' + active, 'data-render': String(++renders) });
    add(app, [
      h('header', { class: 'topbar' }, h('div', { class: 'logo' }, 'FANTASY ', h('b', { text: 'MMADNESS' }), h('small', { text: 'GROWTH ENGINE · BACK OFFICE' })),
        h('span', { class: 'stage-pill', text: 'PRODUCTION PREPARATION · nothing is sent' }),
        h('button', { class: 'signout', testid: 'signout', text: 'Sign out', onclick: function () { signOut('You have signed out.'); } })),
      h('div', { class: 'layout' }, nav, main),
    ]);
    main.appendChild(h('div', { class: 'spinner', text: 'Loading production preparation data…' }));
    return main;
  }
  function head(title, subtitle, actions) {
    return h('div', { class: 'page-head' }, h('div', null, h('h1', { text: title }), subtitle ? h('p', { text: subtitle }) : null), actions ? h('div', { class: 'actions' }, actions) : null);
  }
  function refreshCounts() {
    return Promise.all([api('GET', '/admin/overview'), api('GET', '/admin/alerts')]).then(function (r) {
      state.pendingCount = r[0].overview.draftsAwaitingReview; state.alertCount = r[1].alerts.length;
      paintBadges();
      return r;
    }).catch(function () { /* counts are best-effort */ });
  }

  function paintBadges() {
    var p = document.querySelector('[data-testid=nav-approvals]');
    if (p && state.pendingCount !== null) { var b = p.querySelector('.badge'); if (!b) { b = h('span', { class: 'badge', testid: 'nav-pending' }); p.appendChild(b); } b.textContent = String(state.pendingCount); b.className = 'badge' + (state.pendingCount ? '' : ' zero'); }
    var a = document.querySelector('[data-testid=nav-automation]');
    if (a) { var c = a.querySelector('.badge'); if (state.alertCount) { if (!c) { c = h('span', { class: 'badge', testid: 'nav-alerts' }); a.appendChild(c); } c.textContent = String(state.alertCount); } else if (c) c.remove(); }
  }

  // ---------- draft card (shared by Approvals / Marketing / PR / Affiliate) ----------
  function draftCard(d, reload) {
    var card = h('article', { class: 'draft', testid: 'draft', 'data-draft-id': d.id, 'data-status': d.status });
    var actions = h('div', { class: 'row-actions' });
    var isEmail = d.kind === 'pr' || d.kind === 'affiliate';
    var previewSlot = h('div');
    add(card, [
      h('div', { class: 'draft-top' }, kindChip(d.kind), h('span', { class: 'chip', text: sport(d.genre) }), (d.sandbox === true && d.realDelivery === false ? h('span', { class: 'chip info', text: 'Sandbox receipt — not sent' }) : chip(d.status)), d.editCount ? h('span', { class: 'chip info', text: 'Edited' }) : null, h('span', { class: 'when', text: 'Created ' + when(d.createdAt) })),
      h('h3', { testid: 'draft-title', text: isEmail ? (d.subject || '(no subject)') : (d.headline || '(no headline)') }),
      isEmail ? h('div', { class: 'meta' }, h('span', null, 'To: ', h('strong', { text: d.recipient || '—' })), d.relevanceSource ? h('a', { href: d.relevanceSource, target: '_blank', rel: 'noopener noreferrer', text: 'Why this contact' }) : null) : null,
      d.kind === 'marketing' && d.contest ? fightFacts(d.contest) : null,
      d.kind === 'marketing' && d.poster ? posterPanel(d, reload) : null,
      d.kind === 'marketing' && d.posts ? channelPosts(d) : h('div', { class: 'body', testid: 'draft-text', text: d.text || '' }),
      h('div', { class: 'meta' },
        !isEmail && d.channels ? h('span', { text: 'For: ' + d.channels.join(', ') }) : null,
        d.sourceUrl ? h('a', { href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Source' }) : null,
        d.approvedAt ? h('span', { text: 'Approved ' + when(d.approvedAt) }) : null,
        d.rejectedAt ? h('span', { text: 'Rejected ' + when(d.rejectedAt) + (d.rejectReason ? ' — “' + d.rejectReason + '”' : '') }) : null,
        d.publishedAt ? h('span', null, 'Published ' + when(d.publishedAt), d.postUrl ? [' — ', h('a', { href: d.postUrl, target: '_blank', rel: 'noopener noreferrer', text: 'view post' })] : null) : null,
        d.deliveredAt ? h('span', { text: 'Delivered ' + when(d.deliveredAt) + (d.sandbox ? ' (sandbox)' : '') }) : null),
      previewSlot, actions,
    ]);
    if (isEmail && d.html) actions.appendChild(h('button', { class: 'btn small', testid: 'btn-preview', text: 'Preview email', onclick: function (e) {
      if (previewSlot.firstChild) { clear(previewSlot); e.target.textContent = 'Preview email'; } else { previewSlot.appendChild(emailPreview(d.html)); e.target.textContent = 'Hide preview'; }
    } }));
    if (d.status === 'needs_owner_review') {
      actions.appendChild(h('button', { class: 'btn approve small', testid: 'btn-approve', text: '✓ Approve', onclick: function () { approve(d, reload); } }));
      actions.appendChild(h('button', { class: 'btn small', testid: 'btn-edit', text: 'Edit', onclick: function () { edit(d, reload); } }));
      actions.appendChild(h('button', { class: 'btn danger small', testid: 'btn-reject', text: 'Reject', onclick: function () { reject(d, reload); } }));
    }
    if (d.status === 'approved') {
      if (d.kind === 'marketing') {
        actions.appendChild(h('button', { class: 'btn small', testid: 'btn-copy', text: 'Copy post text', onclick: function () { var sel = card.querySelector('[data-channel].active'); copyText(sel && d.posts ? d.posts[sel.getAttribute('data-channel')] : (d.text || '')); } }));
        if (d.contestId) actions.appendChild(h('button', { class: 'btn primary small', testid: 'btn-schedule', text: '📅 Schedule posts', onclick: function () { schedulePosts(d, reload); } }));
        actions.appendChild(h('button', { class: 'btn approve small', testid: 'btn-mark-published', text: 'Mark as published', onclick: function () { markPublished(d, reload); } }));
      } else actions.appendChild(h('span', { class: 'muted small', text: 'Will be sent only when real email delivery is switched on (currently off).' }));
      actions.appendChild(h('button', { class: 'btn danger small', testid: 'btn-withdraw', text: 'Withdraw approval', onclick: function () { reject(d, reload, true); } }));
    }
        /* BEGIN authorized 2026-11-06 emergency hold presentation. */
    var held = d.review ? d.review.state === 'held' : d.reviewSafety?.state === 'hold' || (d.approvalBlockers || []).length > 0;
    if (held) {
      var blockedApproval = actions.querySelector('[data-testid=btn-approve]');
      if (blockedApproval) { blockedApproval.disabled = true; blockedApproval.title = 'Resolve evidence holds before approval'; }
      ['btn-schedule','btn-mark-published'].forEach(function(id){var button=actions.querySelector('[data-testid='+id+']');if(button)button.disabled=true;});
      if(d.status==='approved'&&isEmail){var note=actions.querySelector('.muted');if(note)note.textContent='On HOLD — delivery remains blocked.';}
      card.insertBefore(h('div', {class:'banner warn',testid:'review-hold'},h('strong',{text:'HOLD — excluded from technically eligible counts'}),h('p',{text:(d.review?.blockers || d.approvalBlockers || d.reviewSafety?.reasons || ['Verification required']).map(function(x){return String(x).replace(/_/g,' ');}).join('; ')})),actions);
    } else if (d.status === 'needs_owner_review') card.insertBefore(h('p',{class:'small muted',testid:'review-eligible',text:'Eligible for owner review. No live delivery is authorized.'}),actions);
        /* END authorized 2026-11-06 emergency hold presentation. */
    return card;
  }
  // Generated FANTASY MMADNESS posters: feed (4:5) and TikTok (9:16), with the artwork source.
  function posterPanel(d, reload) {
    var p = d.poster; var art = p.art || {};
    var thumb = function (fmt, label) { var x = p[fmt]; return x ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer', class: 'poster-thumb', testid: 'poster-' + fmt, title: 'Open full size' }, h('img', { src: x.url, alt: label + ' poster for ' + (d.contest ? d.contest.fighterA + ' vs ' + d.contest.fighterB : 'this fight'), loading: 'lazy', width: '120' }), h('small', { text: label })) : null; };
    var mode = art.mode || (art.used ? 'contest_artwork' : 'text');
    var artChip = mode === 'fighter_photos' ? h('span', { class: 'chip good', testid: 'poster-art', 'data-art': 'fighter_photos', text: '✓ Approved photos of both fighters (unaltered)' })
      : mode === 'contest_artwork' ? h('span', { class: 'chip good', testid: 'poster-art', 'data-art': 'official', text: '✓ Official contest artwork (unaltered)' })
      : h('span', { class: 'chip warn', testid: 'poster-art', 'data-art': 'needs_artwork', text: art.reason === 'artwork_blocked_by_owner' ? 'Artwork blocked: text poster' : 'NEEDS ARTWORK: text poster' + (art.missing && art.missing.length ? ' (no approved photo of ' + art.missing.join(' / ') + ')' : '') });
    var status = p.status === 'hold' ? h('span', { class: 'chip bad', testid: 'poster-status', 'data-status': 'hold', text: 'ON HOLD: ' + (p.holdReasons || []).join('; ').replace(/_/g, ' ') })
      : p.status === 'ready' ? h('span', { class: 'chip good', testid: 'poster-status', 'data-status': 'ready', text: '✓ Poster checked' }) : null;
    var prov = (art.fighters || []).map(function (f) { return h('li', { testid: 'poster-provenance' }, h('strong', { text: f.name + ': ' }), (f.basis || f.source) + (f.approvedBy ? ' (approved by ' + f.approvedBy + ')' : '') + ' · ', h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', text: 'original' }), h('span', { class: 'muted small', text: ' · sha ' + String(f.sha256 || '').slice(0, 10) })); });
    if (art.contestArt) prov.push(h('li', { testid: 'poster-provenance' }, h('strong', { text: 'Matchup artwork: ' }), art.contestArt.basis + ' · ', h('a', { href: art.contestArt.url, target: '_blank', rel: 'noopener noreferrer', text: 'original' })));
    var q = p.qr || {};
    var qrLine = h('span', { class: 'small muted', testid: 'poster-qr', text: 'QR opens: ' + (p.qrUrl || '').replace(/^https:\/\//, '').replace(/\?.*$/, '') + (q.decodedMatches ? ' · ✓ decoded from the poster' : '') + (q.destination && q.destination.ok ? ' · ✓ opens this fight on the website' : (q.destination ? ' · ✗ ' + String(q.destination.reason || '').replace(/_/g, ' ') : '')) });
    var rights = d.contestId && (d.status === 'needs_owner_review' || d.status === 'approved') ? (mode !== 'text'
      ? h('button', { class: 'btn small danger', testid: 'btn-block-art', text: 'Block this artwork', onclick: function () { artRights(d, 'blocked', reload); } })
      : (art.reason === 'artwork_blocked_by_owner' ? h('button', { class: 'btn small', testid: 'btn-allow-art', text: 'Allow artwork again', onclick: function () { artRights(d, 'allowed', reload); } })
        : h('a', { class: 'btn small', href: '#/marketing', testid: 'btn-add-photos', text: 'Add approved fighter photos' }))) : null;
    return h('div', { class: 'posters', testid: 'posters', 'data-mode': mode, 'data-status': p.status || '' }, h('div', { class: 'poster-row' }, thumb('portrait', 'Feed 4:5'), thumb('story', 'TikTok 9:16')),
      h('div', { class: 'meta' }, artChip, status, qrLine, rights), prov.length ? h('ul', { class: 'small provenance' }, prov) : null);
  }
  function artRights(d, status, reload) {
    var note = h('input', { type: 'text', maxlength: '300', testid: 'art-note' });
    return modal({
      title: status === 'blocked' ? 'Block this fight artwork?' : 'Allow the official artwork again?', confirmLabel: status === 'blocked' ? 'Block artwork' : 'Allow artwork', confirmClass: status === 'blocked' ? 'danger' : '',
      body: h('div', null, h('p', { class: 'small', text: status === 'blocked' ? 'The poster is rebuilt without any fighter image. If the campaign was approved it goes back for your review and its scheduled posts are cancelled.' : 'The poster is rebuilt with the official artwork published on this contest.' }),
        status === 'blocked' ? h('label', { class: 'field' }, h('span', { text: 'Reason (required)' }), note) : null),
      onConfirm: function () { return api('POST', '/admin/art-rights/' + encodeURIComponent(d.contestId), { status: status, note: note.value }); },
    }).then(function (ok) { if (ok) { toast(status === 'blocked' ? 'Artwork blocked; poster rebuilt.' : 'Artwork allowed; poster rebuilt.', 'good'); reload(); } }).catch(fail);
  }
  function fightFacts(c) {
    var when = c.dateKey + (c.timing?.eventTimeVerified ? ' · Verified event start: '+String(c.timing.eventStartAt) : ' · Event start time unconfirmed');
    return h('div', { class: 'facts', testid: 'fight-facts' },
      h('span', { class: 'chip good', text: '✓ Verified contest' }),
      h('span', null, h('strong', { text: c.fighterA + ' vs ' + c.fighterB })),
      h('span', { text: sport(c.sport) }), h('span', { text: when }),c.timing?.entryCutoffAt?h('span',{text:'Registry entry cutoff (UTC): '+c.timing.entryCutoffAt}):null,c.timing?.errors?.length?h('span',{class:'chip warn',text:'Approval blocked: '+c.timing.errors.join('; ')}):null,
      c.eventName ? h('span', { text: c.eventName }) : null, c.venue ? h('span', { text: [c.venue, c.city].filter(Boolean).join(', ') }) : null,
      h('a', { href: c.contestUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open contest' }));
  }
  function channelPosts(d) {
    var names = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', tiktok: 'TikTok',youtube_shorts:'YouTube Shorts (draft)' };
    var body = h('div', { class: 'body', testid: 'draft-text', text: d.posts.instagram || d.text || '' });
    var readiness=h('p',{class:'small muted',testid:'caption-readiness',text:(d.platformCopy?.instagram?.blockers||[]).join('; ')||'Review this platform caption before approval.'});
    var tabs = h('div', { class: 'channel-tabs', role: 'tablist' });
    Object.keys(names).forEach(function (ch, i) {
      if (!d.posts[ch]) return;
      tabs.appendChild(h('button', { type: 'button', class: 'btn small' + (i === 0 ? ' active' : ''), 'data-channel': ch, testid: 'channel-' + ch, text: names[ch], onclick: function (e) {
        tabs.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); }); e.target.classList.add('active'); body.textContent = d.posts[ch];readiness.textContent=(d.platformCopy?.[ch]?.blockers||[]).join('; ')||'Tracked destination ready for owner review.';
      } }));
    });
    return h('div', null, tabs, body,readiness);
  }
  function approve(d, reload) {
    var isEmail = d.kind !== 'marketing';
    return modal({
      title: 'Approve this ' + (KIND_NAMES[d.kind] || 'item').toLowerCase() + '?', confirmLabel: 'Approve', confirmClass: 'approve',
      body: (function () {
        var p = h('p', { text: isEmail ? 'Approving queues this email. Real email delivery is OFF in staging, so it will NOT be sent until you switch delivery on.' : 'Approving marks this post ready to publish. Nothing is posted automatically.' });
        /* BEGIN authorized 2026-11-06 final review details. */
        var review = h('section', { testid: 'campaign-final-review' },
          h('h3', { text: d.headline || d.subject || d.id }),
          h('p', { text: 'Draft ID: ' + d.id + ' · Schedule: not authorized by this review.' }),
          h('p', { text: 'Technical staging approval only. Publishing and recipient delivery require separate explicit owner authorization and server-side gates.' }),
          isEmail ? h('p', { text: 'Recipient: ' + (d.recipient || 'Not verified') + ' · Sender: contact@fantasymmadnesscom.com' }) : h('p', { text: 'Channels: ' + (d.channels || Object.keys(d.posts || {})).join(', ') + ' · Destination accounts must be verified in Connections before release.' }),
          isEmail ? h('pre', { class: 'preview-text', text: d.text || 'No message body: do not authorize delivery.' }) : (d.posts ? channelPosts(d) : h('pre', {class:'preview-text',text:d.text || 'No caption: do not authorize publishing.'})),
          d.contest ? h('p', { text: 'Event: ' + (d.contest.eventName || 'Unverified') + ' · Date: ' + (d.contest.dateKey || 'Unverified') + ' · Event start: ' + (d.contest.timeTba ? 'Unconfirmed; contest cutoff is not the event start.' : 'Verify against the published event source before release.') }) : null,
          d.poster ? h('p', { text: 'Artwork: ' + [d.poster.portrait?.id, d.poster.story?.id].filter(Boolean).join(', ') + ' · QR destination: ' + (d.poster.qrUrl || 'Unverified') }) : null);
        var destinations = h('p', { testid: 'final-review-destinations', text: 'Checking current destination configuration…' });
        review.appendChild(destinations);
        api('GET', '/admin/connections').then(function (r) {
          var c = r.connections || {}, selected = c.meta?.selected;
          destinations.textContent = isEmail ? 'Configured sender: ' + (c.email?.sender || 'Not verified') + ' · Recipient and provider delivery approval remain required.' :
            'Facebook: ' + (selected?.pageName && selected?.pageId ? selected.pageName + ' (ID ' + selected.pageId + ')' : 'Not verified — hold release') +
            ' · Instagram: ' + (selected?.igUsername || 'Not verified') + ' · Publishing remains disabled. Review each channel grant in Connections.';
        }).catch(function () { destinations.textContent = 'Destination configuration unavailable — hold release. No credentials changed.'; });
        if (d.poster) review.appendChild(h('div', { class: 'poster-row' }, ['portrait','story'].map(function (format) {
          var image = d.poster[format];
          return image?.url ? h('a', {class:'poster-thumb',href:image.url,target:'_blank',rel:'noopener noreferrer'}, h('img',{src:image.url,alt:format + ' original campaign poster',width:'120'}), h('small',{text:format + ' · open original'})) : null;
        })));
        p = h('div', null, p, review);
        /* END authorized 2026-11-06 final review details. */
        if (isEmail || !d.poster || !d.poster.needsArtwork) return p;
        approve.textBox = h('input', { type: 'checkbox', testid: 'accept-text-poster' });
        return h('div', null, p, h('div', { class: 'banner warn' }, h('div', null, h('strong', { text: 'This fight has no approved photos yet.' }), ' The poster shows the names only. Add approved photos on the Marketing page to get the photo poster, or approve with the text poster.')),
          h('label', { class: 'check-row' }, approve.textBox, ' Approve with the text poster'));
      })(),
      onConfirm: function () { return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/approve', d.poster && d.poster.needsArtwork ? { acceptTextPoster: Boolean(approve.textBox && approve.textBox.checked) } : undefined); },
    }).then(function (ok) { if (ok) { toast('Approved.', 'good'); reload(); refreshCounts(); } }).catch(fail);
  }
  function reject(d, reload, withdraw) {
    var reason = h('input', { type: 'text', maxlength: '200', testid: 'reject-reason', placeholder: 'Optional: why?' });
    return modal({
      title: withdraw ? 'Withdraw your approval?' : 'Reject this item?', confirmLabel: withdraw ? 'Withdraw approval' : 'Reject', confirmClass: 'danger',
      body: h('label', { class: 'field' }, h('span', { text: 'Reason (optional)' }), reason, h('small', { text: 'Rejected items are kept for your records and never sent.' })),
      onConfirm: function () { return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/reject', { reason: reason.value }); },
    }).then(function (ok) { if (ok) { toast(withdraw ? 'Approval withdrawn.' : 'Rejected.', 'good'); reload(); refreshCounts(); } }).catch(function (e) { fail(e); reload(); });
  }
  function edit(d, reload) {
    var isEmail = d.kind !== 'marketing';
    var title = h('input', { type: 'text', maxlength: isEmail ? '200' : '180', testid: 'edit-title' }); title.value = isEmail ? (d.subject || '') : (d.headline || '');
    var channel=h('select',{testid:'edit-caption-platform'});Object.keys(d.posts||{}).forEach(function(ch){channel.appendChild(h('option',{value:ch,text:ch}));});channel.value='facebook';
    var text = h('textarea', { maxlength: '5000', testid: 'edit-text' });text.value=isEmail?(d.text||''):(d.posts?.facebook||d.text||'');channel.onchange=function(){text.value=d.posts[channel.value]||'';};
    return modal({
      title: 'Edit before approving', confirmLabel: 'Save changes',
      body: h('div', null, !isEmail?channel:null,h('label', { class: 'field' }, h('span', { text: isEmail ? 'Subject' : 'Headline' }), title),
        h('label', { class: 'field' }, h('span', { text: isEmail ? 'Email text' : 'Platform caption' }), text, h('small', { text: isEmail ? 'Saving rebuilds the email from this text.' : 'Edit one platform at a time. Names, tracking, length, hashtags and verified destinations are checked.' }))),
      onConfirm: function () {
        var body = { text: text.value };if(!isEmail)body.channel=channel.value; if (isEmail) body.subject = title.value; else body.headline = title.value;
        return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/edit', body);
      },
    }).then(function (ok) { if (ok) { toast('Changes saved. It is still waiting for your approval.', 'good'); reload(); } }).catch(fail);
  }
  function localInput(date) { var z = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); }
  function schedulePosts(d, reload) {
    return Promise.all([api('GET', '/admin/social'), api('GET', '/admin/affiliates').catch(function () { return { affiliates: [] }; })]).then(function (both) {
      var info = both[0]; var affs = (both[1].affiliates || []).filter(function (a) { return a.status === 'active' && a.liveAffiliateId && (!a.genre || a.genre === d.genre); });
      var affSel = h('select', { testid: 'schedule-affiliate', 'aria-label': 'Credit an affiliate' }, [h('option', { value: '', text: 'No: use the standard FANTASY MMADNESS link' })].concat(affs.map(function (a) { return h('option', { value: a.id, text: a.name + ' (' + a.code + ')' }); })));
      var boxes = {}; var names = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', tiktok: 'TikTok',youtube_shorts:'YouTube Shorts (draft)' };
      var when = h('input', { type: 'datetime-local', testid: 'schedule-time' }); when.value = localInput(new Date(Date.now() + 10 * 60000));
      var rows = Object.keys(names).filter(function (ch) { return d.posts && d.posts[ch]; }).map(function (ch) {
        var c = info.channels[ch] || {}; var noImg = c.needsImage && !((d.poster && d.poster.portrait) || (d.contest && d.contest.posterUrl));
        var box = h('input', { type: 'checkbox', testid: 'schedule-' + ch }); box.checked = !noImg; box.disabled = noImg; boxes[ch] = box;
        return h('label', { class: 'check-row' }, box, ' ', h('strong', { text: names[ch] }), ' ',
          noImg ? h('span', { class: 'chip warn', text: 'Needs a fight poster image' }) : c.ready ? h('span', { class: 'chip ' + (c.mode === 'live' ? 'good' : 'info'), text: c.mode === 'live' ? '✓ Live' : 'Sandbox (simulated)' }) : h('span', { class: 'chip warn', text: 'Authorization needed: will be held' }),
          c.note ? h('small', { class: 'muted', text: ' ' + c.note }) : null);
      });
      return modal({
        title: 'Schedule this fight campaign', confirmLabel: 'Schedule',
        body: h('div', null, h('p', { class: 'small', text: 'Each post is checked again against the live contest list right before it goes out. Channels that are not connected yet hold the post until you connect them and press Retry.' }),
          h('div', { class: 'field' }, h('span', { text: 'Channels' }), rows), h('label', { class: 'field' }, h('span', { text: 'Post time (your local time)' }), when),
          h('label', { class: 'field' }, h('span', { text: 'Credit an affiliate (optional)' }), affSel, h('small', { text: affs.length ? 'The fight link becomes this affiliate’s player link, so the live site credits their players.' : 'No active affiliates with a linked live ID yet.' }))),
        onConfirm: function () {
          var chosen = Object.keys(boxes).filter(function (k) { return boxes[k].checked; });
          return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/schedule', { channels: chosen, scheduledAt: new Date(when.value).toISOString(), affiliateId: affSel.value || null });
        },
      });
    }).then(function (res) {
      if (!res) return;
      var okN = (res.results || []).filter(function (r) { return r.ok; }).length; var bad = (res.results || []).filter(function (r) { return !r.ok; });
      toast(okN + ' post' + (okN === 1 ? '' : 's') + ' scheduled' + (bad.length ? '; not scheduled: ' + bad.map(function (b) { return b.channel + ' (' + friendly(b.reason) + ')'; }).join(', ') : '') + '. See the Publishing page.', bad.length ? 'bad' : 'good');
      reload();
    }).catch(fail);
  }
  function markPublished(d, reload) {
    var url = h('input', { type: 'url', placeholder: 'https://…', testid: 'post-url' });
    return modal({
      title: 'Mark this post as published', confirmLabel: 'Mark as published', confirmClass: 'approve',
      body: h('label', { class: 'field' }, h('span', { text: 'Link to the post (optional)' }), url, h('small', { text: 'This only records that you posted it yourself. Nothing is posted from here.' })),
      onConfirm: function () { return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/mark-published', { postUrl: url.value }); },
    }).then(function (ok) { if (ok) { toast('Recorded as published.', 'good'); reload(); } }).catch(fail);
  }
  function draftList(container, query, emptyText) {
    function load() {
      clear(container).appendChild(h('div', { class: 'spinner', text: 'Loading…' }));
      var qs = Object.keys(query).filter(function (k) { return query[k]; }).map(function (k) { return k + '=' + encodeURIComponent(query[k]); }).join('&');
      return api('GET', '/admin/drafts' + (qs ? '?' + qs : '')).then(function (r) {
        clear(container);
        var rows = r.drafts.filter(function (d) { return !query._genre || d.genre === query._genre; });
        /* BEGIN authorized 2026-11-06 queue eligibility filters. */
        var heldCount = rows.filter(function(d){return d.review?.state === 'held' || !d.review && ((d.approvalBlockers || []).length || d.reviewSafety?.state === 'hold');}).length;
        if (query._review) container.appendChild(h('p',{class:'small muted',testid:'queue-review-counts',text:rows.length + ' pending owner review · ' + (rows.length-heldCount) + ' technically eligible · ' + heldCount + ' on HOLD · 0 authorized live deliveries'}));
        if (query._review === 'eligible') rows = rows.filter(function(d){return d.review?.state === 'eligible';});
        if (query._review === 'held') rows = rows.filter(function(d){return d.review?.state === 'held' || !d.review && ((d.approvalBlockers || []).length || d.reviewSafety?.state === 'hold');});
        /* END authorized 2026-11-06 queue eligibility filters. */
        if (!rows.length) { container.appendChild(h('div', { class: 'empty', testid: 'empty', text: emptyText || 'Nothing here right now.' })); return rows; }
        container.appendChild(h('p', { class: 'muted small', testid: 'draft-count', text: rows.length + ' item' + (rows.length === 1 ? '' : 's') }));
        rows.forEach(function (d) { container.appendChild(draftCard(d, load)); });
        return rows;
      }).catch(fail);
    }
    load();
    return load;
  }

  // ---------- pages ----------
  var pages = {};

  // Executive summary: department status, actionable exceptions, and an honest autonomy statement.
  var DEP_ROUTE = { marketing: 'marketing', pr: 'pr', affiliates: 'affiliates', publishing: 'publishing', automation: 'automation', revenue: 'revenue' };
  var DEP_CHIP = { ok: ['good', '✓ On track'], attention: ['warn', '! Needs attention'], blocked: ['bad', '✕ Blocked'], off: ['', '○ Not active'] };
  function executiveCard(ex) {
    if (!ex) return null;
    var card = h('section', { class: 'card exec', testid: 'executive' }, h('h2', { text: 'Executive summary' }));
    var grid = h('div', { class: 'exec-grid' });
    ex.departments.forEach(function (d) {
      var c = DEP_CHIP[d.status] || DEP_CHIP.off;
      grid.appendChild(h('a', { class: 'exec-dept', href: '#/' + (DEP_ROUTE[d.key] || 'overview'), testid: 'exec-' + d.key, 'data-status': d.status },
        h('div', { class: 'exec-head' }, h('strong', { text: d.label }), h('span', { class: 'chip ' + c[0], text: c[1] })),
        h('div', { class: 'exec-headline', text: d.headline }),
        h('ul', { class: 'small muted' }, d.facts.map(function (f) { return h('li', { text: f }); })),
        d.next ? h('div', { class: 'small exec-next', text: '→ ' + d.next }) : null));
    });
    card.appendChild(grid);
    card.appendChild(h('h3', { text: 'Needs action (' + ex.exceptions.length + ')' }));
    card.appendChild(ex.exceptions.length ? h('ul', { class: 'exceptions', testid: 'exec-exceptions' }, ex.exceptions.slice(0, 8).map(function (x) { return h('li', null, h('a', { href: '#/' + x.route, text: x.text })); }))
      : h('p', { class: 'muted small', testid: 'exec-exceptions', text: 'Nothing needs your action right now.' }));
    card.appendChild(h('details', { class: 'small', testid: 'exec-autonomy' }, h('summary', { text: 'What runs on its own, and what needs you' }),
      h('div', { class: 'exec-auto' },
        h('div', null, h('strong', { text: 'Automatic' }), h('ul', null, ex.autonomy.automatic.map(function (t) { return h('li', { text: t }); }))),
        h('div', null, h('strong', { text: 'Needs your approval' }), h('ul', null, ex.autonomy.needsOwner.map(function (t) { return h('li', { text: t }); }))),
        ex.autonomy.notConnected.length ? h('div', null, h('strong', { text: 'Not connected (by design)' }), h('ul', null, ex.autonomy.notConnected.map(function (t) { return h('li', { text: t }); }))) : null)));
    return card;
  }

  // Synthetic money-path test (staging): click -> registration -> settled test payment -> accepted entry -> one credit.
  function syntheticCard(lane) {
    var card = h('section', { class: 'card', testid: 'synthetic-lane' }, h('h2', { text: 'Synthetic end-to-end test (not real money)' }), h('p', { class: 'sub', text: lane.note }));
    var s = lane.steps;
    card.appendChild(h('div', { class: 'grid tiles' },
      tile('Clicks', s.clicks, 'From campaign links', null, 'syn-clicks'), tile('Registrations', s.registrations, 'Synthetic players', null, 'syn-regs'),
      tile('Settled test payments', s.settledTestPayments, 'Signed test events', null, 'syn-pay'), tile('Accepted entries', s.acceptedEntries, 'Required for credit', null, 'syn-acc'),
      tile('Affiliate credits', s.affiliateCredits, 'One per entry, never duplicated', null, 'syn-credits')));
    var rej = Object.keys(lane.rejected || {});
    if (rej.length) card.appendChild(h('p', { class: 'small muted', testid: 'syn-rejected', text: 'Correctly refused: ' + rej.map(function (k) { return k.replace(/_/g, ' ') + ' ×' + lane.rejected[k]; }).join(', ') }));
    var out = h('div', { testid: 'syn-result' });
    card.appendChild(h('button', { class: 'btn primary', testid: 'btn-synthetic-journey', text: 'Run the synthetic journey', onclick: function (e) {
      e.target.disabled = true;
      api('POST', '/admin/synthetic/journey').then(function (x) {
        clear(out).appendChild(h('ul', { class: 'checklist' }, x.steps.map(function (st) { return h('li', { class: st.pass ? 'done' : 'todo' }, h('span', { text: st.pass ? '✓ ' : '✕ ' }), st.step); })));
        toast(x.ok ? 'Synthetic journey passed: one credit, no duplicates.' : 'Synthetic journey found a problem.', x.ok ? 'good' : 'bad'); setTimeout(route, 1200);
      }).catch(function (err) { e.target.disabled = false; fail(err); });
    } }));
    card.appendChild(out);
    return card;
  }

  pages.overview = function (main) {
    return Promise.all([api('GET', '/admin/overview'), api('GET', '/admin/status'), api('GET', '/admin/alerts'), api('GET', '/admin/executive').catch(function () { return null; })]).then(function (r) {
      var o = r[0].overview, st = r[1], alerts = r[2].alerts, sc = st.scheduler, ex = r[3];
      state.pendingCount = o.draftsAwaitingReview; state.alertCount = alerts.length;
      clear(main);
      var rep = o.latestReport;
      add(main, [
        head('Overview', 'Live results from the production Growth Engine (database: ' + st.database.name + ').',
          h('button', { class: 'btn', testid: 'btn-refresh', text: '↻ Refresh', onclick: function () { route(); } })),
        executiveCard(ex),
        sc.preparationPaused ? h('div', { class: 'banner warn', testid: 'scheduler-banner' }, h('strong', { text: 'Emergency stop active. ' }), 'Scheduled preparation is paused; no new work is authorized.') : INTEGRATED && !sc.schedulerEnabled ? h('div', { class: 'banner info', testid: 'scheduler-banner' }, h('strong', { text: 'Manual sandbox operation. ' }), 'No unattended worker is enabled. Last recorded cycle: ' + when(sc.lastRunAt)) : sc.healthy
          ? h('div', { class: 'banner good', testid: 'scheduler-banner' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: '✓' }), h('div', null, h('strong', { text: 'The Growth Engine is running automatically.' }), 'Last automatic run ' + when(sc.lastRunAt) + ' · ' + fmtNum(sc.runsLast24h) + ' runs in the last 24 hours · schedule: ' + sc.schedule + '.'))
          : h('div', { class: 'banner warn', testid: 'scheduler-banner' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: '!' }), h('div', null, h('strong', { text: 'No automatic run in the last 35 minutes.' }), 'Last run: ' + when(sc.lastRunAt) + '. Check the Automation page.')),
        h('div', { class: 'banner info' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ' }), h('div', null, h('strong', { text: 'Real outreach is OFF.' }), 'Email delivery provider: “' + st.delivery.provider + '”. Approved emails wait here; marketing posts are only published when you post them yourself.')),
        h('div', { class: 'grid tiles' },
          tile('Awaiting your approval', o.draftsAwaitingReview, 'Open Campaign Approvals', '#/approvals', 'tile-pending'),
          tile('Approved', o.approvedAwaitingDelivery, 'Ready to publish / send', '#/approvals?status=approved', 'tile-approved'),
          tile('Prospects found', o.prospects, 'Podcasts, creators & fan sources', '#/pr', 'tile-prospects'),
          tile('Open alerts', alerts.length, alerts.length ? 'Needs a look' : 'All clear', '#/automation', 'tile-alerts'),
          tile('Delivered', o.delivered, 'Emails actually sent', '#/automation', 'tile-delivered'),
          tile('Opt-outs', o.suppressions, 'People who must never be contacted', '#/automation', 'tile-optouts')),
        h('div', { id: 'funnel-slot' }),
        h('div', { class: 'grid two' },
          h('section', { class: 'card' }, h('h2', { text: 'Today’s daily report' }),
            rep ? h('div', null, h('p', { class: 'sub', text: 'Saved ' + when(rep.at) }),
              h('table', { class: 'data', testid: 'daily-report' }, h('tbody', null,
                trow('Prospects in database', rep.prospects), trow('Prospects with verified contact', rep.prospectsWithVerifiedContact),
                Object.keys(rep.draftsByKind || {}).map(function (k) { return trow((KIND_NAMES[k] || k) + 's prepared', rep.draftsByKind[k]); }),
                trow('Open alerts', rep.openAlerts), trow('Opt-outs', rep.suppressions), trow('Real delivery', rep.realDelivery ? 'ON' : 'Off'))))
              : h('div', { class: 'empty', text: 'No daily report yet today. It is created by the first automatic run of the day.' })),
          h('section', { class: 'card' }, h('h2', { text: 'Recent automatic runs' }), h('p', { class: 'sub', text: 'The engine wakes up every 15 minutes.' }), runsTable(o.lastRuns.slice(0, 6)))),
      ]);
        /* BEGIN authorized 2026-11-06 truthful overview readiness. */
      if(o.reviewReadiness){var evidence=o.reviewReadiness;main.insertBefore(h('div',{class:'banner info',testid:'overview-review-readiness',text:evidence.pendingOwnerReview+' pending owner review · '+evidence.technicallyEligible+' technically eligible · '+evidence.held+' on HOLD · 0 live deliveries authorized.'}),main.querySelector('.grid.tiles'));}
      var approvedHint=main.querySelector('[data-testid=tile-approved] .hint');if(approvedHint)approvedHint.textContent='Owner reviewed; live delivery still requires separate authorization';
      var deliveredTile=main.querySelector('[data-testid=tile-delivered]');if(deliveredTile&&typeof o.actualDeliveries==='number'){deliveredTile.querySelector('.value').textContent=fmtNum(o.actualDeliveries);deliveredTile.querySelector('.hint').textContent='Actual external deliveries; sandbox captures excluded';}
        /* END authorized 2026-11-06 truthful overview readiness. */
      return api('GET', '/admin/funnel').then(function (f) { var slot = document.getElementById('funnel-slot'); if (slot) slot.appendChild(funnelCard(f.funnel)); });
    });
  };
  function funnelCard(f) {
    return h('section', { class: 'card', testid: 'funnel' }, h('h2', { text: 'Campaign funnel' }), h('p', { class: 'sub', text: 'Each step is counted from its own evidence. Simulated (sandbox) posts never count as published.' }),
      h('div', { class: 'funnel' }, f.stages.map(function (st) {
        return h('div', { class: 'funnel-step' + (st.connected === false ? ' off' : ''), testid: 'funnel-' + st.key }, h('div', { class: 'label', text: st.label }), h('div', { class: 'value', text: st.connected === false && !st.value ? '—' : fmtNum(st.value) }), h('div', { class: 'hint', text: st.source }));
      })));
  }
  function tile(label, value, hint, href, testid) {
    return h('a', { class: 'tile', href: href, testid: testid }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: fmtNum(value) }), h('div', { class: 'hint', text: hint }));
  }
  function trow(a, b) { return h('tr', null, h('td', { text: a }), h('td', { class: 'num', text: typeof b === 'number' ? fmtNum(b) : String(b) })); }
  function runsTable(runs) {
    if (!runs.length) return h('div', { class: 'empty', text: 'No runs yet.' });
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'runs-table' },
      h('thead', null, h('tr', null, h('th', { text: 'Run' }), h('th', { text: 'Started' }), h('th', { text: 'Result' }), h('th', { class: 'num', text: 'Jobs done' }))),
      h('tbody', null, runs.map(function (r) {
        return h('tr', null, h('td', { class: 'mono', text: r.runId }), h('td', { class: 'nowrap', text: when(r.createdAt) }), h('td', null, chip(r.state)), h('td', { class: 'num', text: r.completed === undefined ? '—' : fmtNum(r.completed) }));
      }))));
  }

  pages.approvals = function (main, params) {
    var q = { status: params.status === undefined ? 'needs_owner_review' : params.status, kind: params.kind || '', _genre: params.sport || '', limit: 300 };
        /* BEGIN authorized 2026-11-06 owner review state. */
    q._review = q.status === 'needs_owner_review' ? (params.review || 'eligible') : '';
        /* END authorized 2026-11-06 owner review state. */
    var list = h('div', { testid: 'approval-list' });
    var statusSel = h('select', { testid: 'filter-status', 'aria-label': 'Status' },
      [['needs_owner_review', 'Awaiting approval'], ['approved', 'Approved'], ['published', 'Published'], ['delivered', 'Delivered'], ['rejected', 'Rejected'], ['', 'Everything']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    statusSel.value = q.status;
    var kindSel = h('select', { testid: 'filter-kind', 'aria-label': 'Type' }, [['', 'All types'], ['marketing', 'Marketing posts'], ['pr', 'PR emails'], ['affiliate', 'Affiliate invites']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    kindSel.value = q.kind;
    var sportSel = sportSelect(q._genre, function () { go(); }); sportSel.setAttribute('data-testid', 'filter-sport');
    function go() { location.hash = '#/approvals?status=' + encodeURIComponent(statusSel.value) + '&kind=' + encodeURIComponent(kindSel.value) + '&sport=' + encodeURIComponent(sportSel.value); }
    statusSel.addEventListener('change', go); kindSel.addEventListener('change', go);
    clear(main);
    add(main, [
      head('Campaign Approvals', 'Everything the Growth Engine prepares waits here for you. Nothing goes out without your approval.'),
      h('div', { class: 'filters' }, h('label', null, 'Show', statusSel), h('label', null, 'Type', kindSel), h('label', null, 'Sport', sportSel)),
      list,
    ]);
        /* BEGIN authorized 2026-11-06 owner review controls. */
    var reviewSelect = h('select', {'aria-label':'Evidence readiness',testid:'filter-review'}, [['eligible','Technically eligible for review'],['held','Held — evidence required'],['all','All pending items']].map(function(o){return h('option',{value:o[0],text:o[1]});}));
    reviewSelect.value = q._review || 'all';
    reviewSelect.onchange = function(){location.hash='#/approvals?status='+encodeURIComponent(statusSel.value)+'&kind='+encodeURIComponent(kindSel.value)+'&sport='+encodeURIComponent(sportSel.value)+'&review='+encodeURIComponent(reviewSelect.value);};
    main.querySelector('.filters').appendChild(h('label',null,'Evidence',reviewSelect));
        /* END authorized 2026-11-06 owner review controls. */
    draftList(list, q, q.status === 'needs_owner_review' ? 'Nothing is waiting for your approval right now.' : 'No items match these filters.');
    return Promise.resolve();
  };

  pages.marketing = function (main, params) {
        /* BEGIN authorized 2026-11-06 posters route. */
    if(params.view === 'posters') return posterDepartment(main,params);
        /* END authorized 2026-11-06 posters route. */
    var g = params.sport || '';
    return Promise.all([api('GET', '/admin/marketing/coverage'), api('GET', '/admin/drafts?kind=marketing&limit=300' + (params.fightId ? '&contestId=' + encodeURIComponent(params.fightId) : ''))]).then(function (r) {
      var cov = r[0].coverage, drafts = r[1].drafts, latest = cov.latest;
      clear(main);
      var counts = {}; drafts.forEach(function (d) { counts[d.status] = (counts[d.status] || 0) + 1; });
      var list = h('div', { testid: 'marketing-list' });
      var sel = sportSelect(g, function (v) { location.hash = '#/marketing?' + (v ? 'sport=' + encodeURIComponent(v) + '&' : '') + (params.fightId ? 'fightId=' + encodeURIComponent(params.fightId) : ''); }); sel.setAttribute('data-testid', 'filter-sport');
      var checkNow = h('button', { class: 'btn primary', testid: 'btn-check-fights', text: '↻ Check for new fights now', onclick: function () {
        checkNow.disabled = true;
        api('POST', '/admin/marketing/refresh').then(function (res) {
          var x = res.result;
          toast(x.sourceReachable ? ('Checked the published contests: ' + x.verifiedContests + ' verified fight' + (x.verifiedContests === 1 ? '' : 's') + ', ' + x.created + ' new campaign' + (x.created === 1 ? '' : 's') + (x.withdrawn ? ', ' + x.withdrawn + ' withdrawn' : '') + '.') : 'Could not reach the FANTASY MMADNESS contest list. Nothing was changed.', x.sourceReachable ? 'good' : 'bad');
          refreshCounts(); route();
        }).catch(function (e) { checkNow.disabled = false; fail(e); });
      } });
      var rows = cov.sports.map(function (sp) {
        var c = latest && latest.sports && latest.sports[sp] || null;
        var state = !latest ? h('span', { class: 'chip', text: 'Not checked yet' })
          : !latest.sourceReachable ? h('span', { class: 'chip bad', text: '! Contest list unreachable' })
          : c.verifiedContests ? h('span', { class: 'chip good', text: '✓ Covered' })
          : h('span', { class: 'chip warn', text: 'No open contest published' });
        return h('tr', { testid: 'coverage-row', 'data-sport': sp }, h('td', null, h('strong', { text: sport(sp) })), h('td', { class: 'num', text: c ? fmtNum(c.verifiedContests) : '—' }), h('td', { class: 'num', text: c ? fmtNum(c.campaignsActive) : '—' }), h('td', { class: 'num', text: c ? fmtNum(c.rejectedContests) : '—' }), h('td', null, state));
      });
      var blocked = (latest && latest.sports ? cov.sports.reduce(function (acc, sp) { return acc.concat((latest.sports[sp].rejected || []).map(function (x) { return Object.assign({ sport: sp }, x); })); }, []) : []);
      add(main, [
        head('Marketing', 'Social posts for real, upcoming fights that have an open FANTASY MMADNESS contest. Nothing is posted automatically.', checkNow),
        latest && latest.sourceErrors && latest.sourceErrors.length ? h('div', { class: 'banner bad', role: 'alert', text: 'Fight Registry check incomplete: ' + latest.sourceErrors.join('; ') + '. Existing campaigns are retained until their source can be verified.' }) : null,
        h('div', { class: 'banner info' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ' }), h('div', null, h('strong', { text: 'Where campaigns come from' }),
          'Only fights published as open contests on FANTASY MMADNESS. Every fight is checked first: real fighter names, a future date, one of the five sports, entries still open. It is checked again when you approve. Podcasts, shows and creators go to Public Relations and Affiliate Recruitment, never here. No prizes, fees or event details are added that the contest does not show.')),
        h('div', { class: 'grid tiles' },
          tile('Posts awaiting approval', counts.needs_owner_review || 0, 'Review below', '#/approvals?kind=marketing', 'mkt-pending'),
          tile('Approved, not yet posted', counts.approved || 0, 'Copy & post, then mark published', '#/approvals?status=approved&kind=marketing', 'mkt-approved'),
          tile('Published', counts.published || 0, 'Recorded by you', '#/approvals?status=published&kind=marketing', 'mkt-published'),
          tile('Verified fights', latest ? latest.verifiedContests : null, latest ? 'Checked ' + when(latest.checkedAt) : 'Not checked yet', '#/marketing', 'mkt-verified')),
        h('section', { class: 'card' }, h('h2', { text: 'All five sports' }), h('p', { class: 'sub', text: cov.horizonNote + ' The engine re-checks every 6 hours; a sport with no open contest gets no campaign rather than an invented one.' }),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'coverage-table' },
            h('thead', null, h('tr', null, h('th', { text: 'Sport' }), h('th', { class: 'num', text: 'Verified fights' }), h('th', { class: 'num', text: 'Active campaigns' }), h('th', { class: 'num', text: 'Fights not used' }), h('th', { text: 'Status' }))),
            h('tbody', null, rows)))),
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Fight campaigns' }), h('div', { class: 'right' }, h('label', { class: 'small muted' }, 'Sport ', sel))), list),
        h('section', { class: 'card' }, h('h2', { text: 'Fights the safeguard did not use' }), h('p', { class: 'sub', text: 'Listings that failed verification (for example a show name instead of fighters, a past date, or a closed contest). No campaign was prepared for these.' }),
          blocked.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'blocked-table' }, h('thead', null, h('tr', null, h('th', { text: 'Listing' }), h('th', { text: 'Sport' }), h('th', { text: 'Why it was not used' }))),
            h('tbody', null, blocked.map(function (b) { return h('tr', { testid: 'blocked-row' }, h('td', { text: b.label || b.id || '—' }), h('td', { text: sport(b.sport) }), h('td', { class: 'small', text: (b.reasons || []).map(function (x) { return String(x).replace(/_/g, ' '); }).join('; ') })); })))) : h('div', { class: 'empty', text: 'Nothing was blocked in the latest check.' })),
      ]);
      draftList(list, { kind: 'marketing', limit: 300, _genre: g, contestId: params.fightId || '' }, 'No fight campaigns yet.');
      main.appendChild(photoLibrary());
      if (INTEGRATED) main.appendChild(departmentReceipts('marketing'));
    });
  };
  // Approved fighter photos: originals of the exact named fighter, approved by the owner.
  function photoLibrary() {
    var card = h('section', { class: 'card', testid: 'photo-library' }, h('h2', { text: 'Approved fighter photos' }),
      h('p', { class: 'sub', text: 'Posters use a fighter photo only when it is the photo FANTASY MMADNESS attached to the contest, or a photo you approve here for that exact fighter. Photos are never cropped or changed. Without approved photos of both fighters the poster uses the contest artwork, or names only (NEEDS ARTWORK).' }));
    var body = h('div', null, h('div', { class: 'spinner', text: 'Loading…' })); card.appendChild(body);
    var name = h('input', { type: 'text', maxlength: '80', testid: 'photo-name', placeholder: 'Fighter name exactly as on the contest' });
    var url = h('input', { type: 'url', maxlength: '500', testid: 'photo-url', placeholder: 'https://res.cloudinary.com/… (your FANTASY MMADNESS upload)' });
    var note = h('input', { type: 'text', maxlength: '300', testid: 'photo-note', placeholder: 'Rights: e.g. Official promotion photo, licensed for promotion' });
    var add = h('button', { class: 'btn primary small', testid: 'btn-approve-photo', text: 'Approve this photo', onclick: function () {
      add.disabled = true;
      api('POST', '/admin/fighter-assets', { fighterName: name.value, imageUrl: url.value, rightsNote: note.value }).then(function (r) {
        toast('Photo approved for ' + r.asset.fighterName + '. Posters updated: ' + ((r.posters && r.posters.generated) || 0) + '.', 'good'); name.value = url.value = note.value = ''; load();
      }).catch(fail).then(function () { add.disabled = false; });
    } });
    card.appendChild(h('div', { class: 'form-row', testid: 'photo-form' }, name, url, note, add));
    function load() {
      api('GET', '/admin/fighter-assets').then(function (r) {
        clear(body);
        if (!r.assets.length) { body.appendChild(h('p', { class: 'muted small', testid: 'photo-empty', text: 'No photos approved here yet.' })); return; }
        body.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'photo-table' }, h('thead', null, h('tr', null, h('th', { text: 'Fighter' }), h('th', { text: 'Photo' }), h('th', { text: 'Rights / reason' }), h('th', { text: 'By' }), h('th', { text: '' }))),
          h('tbody', null, r.assets.map(function (a) {
            return h('tr', { testid: 'photo-row', 'data-asset-id': a.id, 'data-kind': a.kind },
              h('td', { text: a.kind === 'block' ? 'BLOCKED photo' : a.fighterName }), h('td', null, h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: a.url, alt: a.fighterName || 'blocked photo', width: '56', loading: 'lazy' }))),
              h('td', { class: 'small', text: a.rightsNote || a.note || '' }), h('td', { class: 'small', text: (a.approvedBy || a.by || '') + ' ' + when(a.approvedAt || a.at) }),
              h('td', null, h('button', { class: 'btn small danger', testid: 'btn-revoke-photo', text: a.kind === 'block' ? 'Unblock' : 'Revoke', onclick: function () {
                api('POST', '/admin/fighter-assets/' + encodeURIComponent(a.id) + '/revoke').then(function () { toast('Done. Posters updated.', 'good'); load(); }).catch(fail);
              } })));
          })))));
      }).catch(function (e) { clear(body); body.appendChild(h('p', { class: 'error', text: explain(e) })); });
    }
    load();
    return card;
  }

  var OUTCOME = {
    drafted: ['Personalized email drafted', 'good'], already_has_outreach: ['Already contacted / drafted', 'info'],
    no_verified_contact_route: ['No published business contact', 'warn'], no_evidence_based_angle: ['No evidence-based angle yet', 'warn'],
    research_failed: ['Research failed (will retry)', 'bad'], composer_safeguard: ['Blocked by the safety check', 'bad'],
  };
  function outreachPage(main, params, cfg) {
    var g = params.sport || SPORTS[0];
    return Promise.all([api('GET', '/admin/research?track=' + cfg.kind), api('GET', '/admin/drafts?kind=' + cfg.kind + '&limit=200')]).then(function (r) {
      var res = r[0], drafts = r[1].drafts, c = res.counts;
      clear(main);
      var awaiting = drafts.filter(function (d) { return d.status === 'needs_owner_review'; }).length;
      var byDraft = {}; drafts.forEach(function (d) { byDraft[d.id] = d; });
      var tabs = h('div', { class: 'tabs', role: 'tablist', testid: 'sport-tabs' });
      SPORTS.forEach(function (s) {
        tabs.appendChild(h('button', { role: 'tab', class: s === g ? 'active' : '', 'aria-selected': String(s === g), testid: 'tab-' + s, onclick: function () { location.hash = '#/' + cfg.route + '?sport=' + s; } },
          sport(s), h('span', { class: 'badge zero', text: String(res.bySport[s] || 0) })));
      });
      var detail = h('div', { testid: 'prepared-list' });
      var list = h('div', { testid: cfg.kind + '-draft-list' });
      add(main, [
        head(cfg.title, cfg.subtitle),
        h('div', { class: 'grid tiles' },
          tile('Shows researched', c.researched, c.waitingForResearch + ' more waiting for research', '#/' + cfg.route, cfg.kind + '-researched'),
          tile('Published business contacts', c.publishedContacts, 'Found in each show’s own public feed', '#/' + cfg.route, cfg.kind + '-contacts'),
          tile('Personalized emails', c.drafted, 'Evidence-based, one per show', '#/' + cfg.route, cfg.kind + '-drafted'),
          tile('Awaiting approval', awaiting, 'Nothing is sent without you', '#/approvals?kind=' + cfg.kind, cfg.kind + '-awaiting')),
        h('div', { class: 'banner info' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ' }), h('div', null, h('strong', { text: 'How this works' }),
          'Every 15 minutes the engine researches a few shows: their own public podcast feed, recent episodes, and the business contact the show publishes. When there is a verified contact and real evidence (for example the show discussed an upcoming fight), it writes a personalized email for your approval. Nothing is guessed and nothing is sent. Shows with no published contact are listed so you can add one you have verified yourself.')),
        h('section', { class: 'card' }, h('h2', { text: 'Researched ' + cfg.noun }), tabs, detail),
        h('section', { class: 'card' }, h('h2', { text: 'Personalized ' + cfg.noun + ' emails' }), h('p', { class: 'sub', text: 'Approve or reject them here or in Campaign Approvals. Approved emails go to the sandbox only until real sending is authorized.' }), list),
      ]);
      draftList(list, { kind: cfg.kind, limit: 200 }, 'None yet. They appear as research finds shows with a published contact and a real reason to write.');
      if (cfg.kind === 'affiliate') { var pipe = h('section', { class: 'card', testid: 'onboarding' }, h('h2', { text: 'Onboarding pipeline' }), h('div', { class: 'spinner', text: 'Loading…' })); main.insertBefore(pipe, main.children[3] || null); onboarding(pipe); }
      var rows = res.shows.filter(function (x) { return x.genre === g; });
      if (!rows.length) { detail.appendChild(h('div', { class: 'empty', testid: 'research-empty', text: 'No ' + sport(g) + ' shows researched for ' + cfg.noun + ' yet. ' + (INTEGRATED ? 'Use Automation → Run now to prepare sourced research in the sandbox.' : 'Research runs automatically every 15 minutes.') })); return; }
      var tbody = h('tbody');
      rows.forEach(function (x) {
        var o = OUTCOME[x.outcome] || ['Not researched yet', ''];
        var draft = x.draftId ? byDraft[x.draftId] : null;
        var tr = h('tr', { testid: 'prepared-row', 'data-prospect-id': x.id, 'data-outcome': x.outcome || '' });
        var preview = h('tr', { class: 'preview-row' }); preview.hidden = true;
        var previewCell = h('td', { colspan: '5' }); preview.appendChild(previewCell);
        var evidence = [].concat(x.angle ? [x.angle.why] : [], x.evidence.filter(function (e) { return !x.angle || e.text !== x.angle.why; }).map(function (e) { return e.text; })).slice(0, 2);
        add(tr, [
          h('td', null, h('strong', { text: (x.show && x.show.title) || x.name }), h('div', { class: 'small muted', text: [x.score !== null ? 'Score ' + x.score : null, x.active ? 'active show' : x.researchedAt ? 'no recent episodes' : null].filter(Boolean).join(' · ') }),
            h('div', { class: 'small' }, h('a', { href: x.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Listing' }), x.feed ? [' · ', h('a', { href: x.feed, target: '_blank', rel: 'noopener noreferrer', text: 'Public feed' })] : null)),
          h('td', { class: 'small' }, x.recentEpisode ? h('div', { text: 'Latest: “' + x.recentEpisode.title + '”' }) : null, evidence.map(function (t) { return h('div', { class: 'muted', text: '• ' + t }); })),
          h('td', null, x.contact ? h('div', null, h('span', { class: 'chip good', testid: 'research-contact', text: '✓ ' + x.contact.email }), h('div', { class: 'small muted', text: x.contact.manual ? 'Added by you' : 'Published in the show’s feed (' + x.contact.field + ')' }))
            : x.optedOut ? h('span', { class: 'chip bad', text: 'Opted out' }) : h('div', null, h('span', { class: 'chip', text: 'No contact' }), x.contactProblems.length ? h('div', { class: 'small muted', text: x.contactProblems[0] }) : null)),
          h('td', null, h('span', { class: 'chip ' + o[1], testid: 'research-outcome', text: o[0] }), x.error ? h('div', { class: 'small muted', text: x.error }) : null),
          h('td', { class: 'nowrap' },
            draft ? h('button', { class: 'btn small', testid: 'btn-view-template', text: 'View email', onclick: function (e) {
              if (!preview.hidden) { preview.hidden = true; clear(previewCell); e.target.textContent = 'View email'; return; }
              previewCell.appendChild(emailPreview(draft.html)); preview.hidden = false; e.target.textContent = 'Hide email';
            } }) : null, ' ',
            !x.contact && !x.optedOut ? h('button', { class: 'btn primary small', testid: 'btn-add-contact', text: 'Add verified contact', onclick: function () { addContact(x.id, (x.show && x.show.title) || x.name, cfg.kind); } }) : null),
        ]);
        tbody.appendChild(tr); tbody.appendChild(preview);
      });
      add(detail, [h('p', { class: 'muted small', testid: 'prepared-count', text: rows.length + ' researched for ' + sport(g) }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'Show' }), h('th', { text: 'Evidence' }), h('th', { text: 'Contact' }), h('th', { text: 'Status' }), h('th', { text: '' }))), tbody))]);
    });
  }
  function onboarding(box) {
    return api('GET', '/admin/affiliates').then(function (r) {
      while (box.children.length > 1) box.removeChild(box.lastChild);
      add(box, h('p', { class: 'sub', text: 'Approved invitation → invited → active. A creator becomes active when they have joined the live FANTASY MMADNESS affiliate program and you link their live affiliate ID. From then on the live site credits their players itself.' }));
      if (!r.affiliates.length) { box.appendChild(h('div', { class: 'empty', testid: 'onboarding-empty', text: 'No one yet. Approve an affiliate invitation below to start.' })); return; }
      var tbody = h('tbody');
      r.affiliates.forEach(function (a) {
        var acts = h('td', { class: 'nowrap' });
        var step = function (label, status, testid, cls, extra) { acts.appendChild(h('button', { class: 'btn small ' + (cls || ''), testid: testid, text: label, onclick: function () { (extra ? extra() : Promise.resolve({})).then(function (body) { if (!body) return; return api('POST', '/admin/affiliates/' + encodeURIComponent(a.id) + '/status', Object.assign({ status: status }, body)).then(function () { toast('Updated.', 'good'); onboarding(box); }); }).catch(fail); } })); };
        if (a.status === 'invite_prepared') step('Mark invited (I sent it)', 'invited', 'btn-aff-invited');
        if (a.status === 'invited' || a.status === 'paused') step('Link live affiliate', 'active', 'btn-aff-activate', 'primary', function () {
          var id = h('input', { type: 'text', maxlength: '24', testid: 'live-affiliate-id', placeholder: '24-character ID' });
          var out = null;
          return modal({ title: 'Link ' + a.name + ' to the live affiliate program', confirmLabel: 'Link and activate', body: h('div', null, h('p', { class: 'small', text: 'After they sign up with the onboarding link, find them in the live Affiliate back office and paste their affiliate ID here.' }), h('label', { class: 'field' }, h('span', { text: 'Live affiliate ID' }), id)),
            onConfirm: function () { out = { liveAffiliateId: id.value.trim() }; return api('POST', '/admin/affiliates/' + encodeURIComponent(a.id) + '/status', { status: 'active', liveAffiliateId: out.liveAffiliateId }); } }).then(function (ok) { if (ok) { toast(a.name + ' is now an active affiliate.', 'good'); onboarding(box); } return null; });
        });
        if (a.status === 'active') step('Pause', 'paused', 'btn-aff-pause', 'danger');
        if (['invite_prepared', 'invited', 'paused'].indexOf(a.status) >= 0) step('Declined', 'declined', 'btn-aff-decline');
        tbody.appendChild(h('tr', { testid: 'aff-row', 'data-aff-id': a.id, 'data-status': a.status },
          h('td', null, h('strong', { text: a.name }), h('div', { class: 'small muted', text: sport(a.genre) + (a.email ? ' · ' + a.email : '') })),
          h('td', null, chip(a.status)),
          h('td', { class: 'small' }, h('button', { class: 'btn small link', testid: 'btn-copy-onboarding', text: 'Copy onboarding link', onclick: function () { copyText(a.onboardingLink); } }),
            a.playerLinks.length ? h('div', null, a.playerLinks.map(function (pl) { return h('div', null, h('button', { class: 'btn small link', testid: 'btn-copy-player-link', text: 'Copy player link: ' + pl.label, onclick: function () { copyText(pl.link); } })); })) : null),
          acts));
      });
      box.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'onboarding-table' }, h('thead', null, h('tr', null, h('th', { text: 'Creator' }), h('th', { text: 'Status' }), h('th', { text: 'Links' }), h('th', { text: '' }))), tbody)));
    }).catch(fail);
  }
  function addContact(prospectId, name, kind) {
    var email = h('input', { type: 'email', required: true, maxlength: '254', testid: 'contact-email', placeholder: 'name@business.com' });
    var consent = h('textarea', { maxlength: '200', testid: 'contact-consent', placeholder: 'e.g. Listed as the business contact on their official media kit page' });
    var kindSel = h('select', { testid: 'contact-kind' }, h('option', { value: 'pr', text: 'PR / media coverage' }), h('option', { value: 'affiliate', text: 'Affiliate recruitment' }));
    kindSel.value = kind; consent.style.minHeight = '70px';
    return modal({
      title: 'Add a verified contact for ' + (name || 'this prospect'), confirmLabel: 'Create email for approval',
      body: h('div', null,
        h('label', { class: 'field' }, h('span', { text: 'Business email' }), email, h('small', { text: 'Only use an address the business published for this purpose or gave you directly.' })),
        h('label', { class: 'field' }, h('span', { text: 'Email type' }), kindSel),
        h('label', { class: 'field' }, h('span', { text: 'How did they agree to be contacted? (required)' }), consent)),
      onConfirm: function () { return api('POST', '/admin/prospects/' + encodeURIComponent(prospectId) + '/contact', { contact: email.value.trim(), kind: kindSel.value, consentNote: consent.value }); },
    }).then(function (ok) { if (ok) { toast('Personalized email created. It is waiting in Campaign Approvals.', 'good'); refreshCounts(); route(); } }).catch(fail);
  }
  function departmentReceipts(kind) {
    var card = h('section', { class: 'card', testid: 'department-receipts-' + kind }, h('h2', { text: 'Recent sandbox receipts' }), h('p', { text: 'Loading receipts…' }));
    var path = kind === 'marketing' ? '/admin/social?status=published' : '/admin/email/sandbox?limit=100';
    api('GET', path).then(function (r) {
      var rows = kind === 'marketing' ? (r.posts || []).filter(function (p) { return p.sandbox === true; }) : (r.messages || []).filter(function (m) { return m.kind === kind && m.sent === false; });
      card.lastChild.textContent = rows.length ? rows.length + ' recent sandbox receipt(s). Nothing was sent to a real account or recipient.' : 'No sandbox receipts for this department yet. Approve a draft and run a sandbox cycle to create one.';
      if (rows.length) card.appendChild(h('ul', null, rows.map(function (x) { return h('li', { text: (x.providerPostId || x.id) + ' · ' + (x.message?.subject || x.channel || kind) + ' · sandbox only' }); })));
      card.appendChild(h('a', { href: '#/analytics', text: 'View reporting and attribution' }));
    }).catch(function (e) { card.lastChild.textContent = 'Receipts unavailable: ' + e.message; });
    return card;
  }
  pages.pr = function (main, params) {
    return outreachPage(main, params, { kind: 'pr', department: 'public-relations', route: 'pr', title: 'Public Relations', noun: 'media outreach', subtitle: 'Media coverage outreach to combat-sports podcasts and shows.' }).then(function () { if (INTEGRATED) main.appendChild(departmentReceipts('pr')); });
  };
  pages.affiliates = function(main,params){
    var query=new URLSearchParams();['sport','partnerType','country','platform','status','expectedPartnershipValue','contactVerified','audienceVerified','engagementQuality','minAudience'].forEach(function(k){if(params[k])query.set(k,params[k]);});
    return api('GET','/admin/recruitment?'+query).then(function(r){
      clear(main);var c=r.counters,filters=h('div',{class:'form-row',testid:'recruitment-filters'});
      function choose(key,label,values){var select=h('select',{'aria-label':label,testid:'recruitment-'+key},h('option',{value:'',text:'All '+label}));values.forEach(function(v){select.appendChild(h('option',{value:v,text:v.replace(/_/g,' ')}));});select.value=params[key]||'';select.onchange=function(){var p=new URLSearchParams(query);if(select.value)p.set(key,select.value);else p.delete(key);location.hash='#/affiliates?'+p;};filters.appendChild(select);}
      choose('sport','sports',SPORTS);choose('partnerType','partner types',['fighter','wrestler','trainer','gym','manager','promoter','creator','commentator']);choose('status','statuses',['discovered','researched','contact_verified','awaiting_approval','approved','responded','onboarding','active','rejected','opted_out']);choose('platform','platforms',['official_website']);choose('contactVerified','verified contacts',['true']);choose('audienceVerified','verified audiences',['true']);choose('engagementQuality','engagement evidence',['verified']);choose('expectedPartnershipValue','partnership values',['qualified_review','research_needed']);
      var country=h('input',{type:'text',placeholder:'Country / region','aria-label':'Country or region',value:params.country||''});country.onchange=function(){var p=new URLSearchParams(query);if(country.value)p.set('country',country.value);else p.delete('country');location.hash='#/affiliates?'+p;};filters.appendChild(country);
      var list=h('div'),pipeline=h('div');
      add(main,[head('Affiliate Recruitment','Independent, source-backed partnership acquisition across all five sports.'),
       h('div',{class:'grid tiles'},tile('Prospects researched',c.researched,'Independent partner research','#/affiliates'),tile('Verified business contacts',c.verifiedContacts,'Explicitly published contacts','#/affiliates'),tile('Invitations drafted',c.drafted,'Separate from PR podcasts','#/affiliates'),tile('Awaiting approval',c.awaitingApproval,'No external messages sent','#/approvals?kind=affiliate')),
       h('p',{class:'small muted',testid:'recruitment-schedule',text:'Last research: '+when(r.lastResearch?.lastAt)+' · Next scheduled activity: '+when(r.nextScheduledAt)}),
       r.lastResearch?.error?h('p',{class:'error',role:'alert',text:'Discovery error: '+r.lastResearch.error}):null,
       h('div',{class:'banner info',text:'Public structured sources identify fighters, wrestlers, trainers, gyms, managers, promoters and creators. Official website evidence is required for contacts. Audience, engagement and conversion potential remain unknown unless verified. Podcasts remain in PR unless independently qualified.'}),filters,
       h('section',{class:'card',testid:'recruitment-prospects'},h('h2',{text:'Partner research'}),r.prospects.length?h('div',null,...r.prospects.map(function(p){return h('article',{class:'card',testid:'recruitment-prospect'},h('h3',{text:p.name}),h('p',{text:sport(p.sport)+' · '+p.partnerType+' · '+(p.country||'Country unverified')+' · '+p.status}),h('p',{text:'Review score: '+(p.score||0)+' (heuristic) · Audience: '+(p.audienceSize==null?'unverified':p.audienceSize)+' · Engagement: '+(p.engagementQuality==null?'unverified':p.engagementQuality)}),h('p',{text:p.contact?.verified?'Verified business contact: '+p.contact.email:'No verified business contact'}),...(p.evidence||[]).map(function(e){return h('p',{class:'small'},h('a',{href:e.sourceUrl,target:'_blank',rel:'noopener noreferrer',text:(e.text||e.kind)+' · '+when(e.retrievedAt)}));}),p.error?h('p',{class:'error',text:p.error}):null,h('button',{class:'btn small',text:'Record correction',onclick:function(){var source=h('input',{type:'url',placeholder:'Source URL',value:p.sourceUrl}),note=h('input',{type:'text',placeholder:'Verified correction note',maxlength:'300'});modal({title:'Record a source-backed correction',body:h('div',null,source,note),onConfirm:function(){return api('POST','/admin/recruitment/'+encodeURIComponent(p.id)+'/correct',{sourceUrl:source.value,note:note.value});}}).then(route).catch(fail);}}),h('button',{class:'btn small danger',text:'Reject prospect',onclick:function(){api('POST','/admin/recruitment/'+encodeURIComponent(p.id)+'/status',{status:'rejected'}).then(route).catch(fail);}}),h('button',{class:'btn small',text:'Opt out',onclick:function(){api('POST','/admin/recruitment/'+encodeURIComponent(p.id)+'/status',{status:'opted_out'}).then(route).catch(fail);}}));})):h('p',{class:'empty',text:'No independently qualified partners match these filters. Sources and errors are recorded; no prospects are invented.'})),
       h('section',{class:'card'},h('h2',{text:'Invitation review'}),h('p',{text:'Signup destination: '+(r.program.signupVerified?'verified':'not yet verified')+'. Approved affiliate terms require owner review. No rates, earnings or free setup are promised.'}),list),
       h('section',{class:'card'},h('h2',{text:'Lifecycle and reporting'}),h('p',{text:'Discovered → Researched → Contact Verified → Draft Prepared → Awaiting Approval → Approved → Invited → Responded → Onboarding → Active → Attributed Conversions'}),h('p',{text:'Approved: '+c.approved+' · Sandbox captures (not sent): '+c.sandboxCaptures+' · Responses: '+c.responses+' · Onboarded: '+c.onboarded+' · Active: '+c.active+' · Paying conversions: verified production attribution not connected'}),pipeline)]);
      draftList(list,{kind:'affiliate',limit:200},'No invitations awaiting research yet.');onboarding(pipeline);if(INTEGRATED)main.appendChild(departmentReceipts('affiliate'));
        /* BEGIN authorized 2026-11-06 recruitment evidence history. */
      main.querySelectorAll('[data-testid=recruitment-prospect]').forEach(function(card,index){
        var prospect=r.prospects[index];if(!prospect)return;
        card.appendChild(h('p',{class:'small',text:'Recipient status: '+(prospect.deceased?'Source reports deceased — outreach held':prospect.outreachHold?'Outreach held for status verification':'Current status requires primary-source verification')+'. Commercial affiliate agreement: '+(r.program.commercialActivationApproved?'verified':'not approved for activation')+'.'}));
        card.appendChild(h('details',null,h('summary',{text:'Research and outreach history'}),h('ul',{class:'small'},(prospect.history||[]).map(function(entry){return h('li',null,String(entry.stage||'Recorded event').replace(/_/g,' ')+' · '+when(entry.at),entry.sourceUrl?h('a',{href:entry.sourceUrl,target:'_blank',rel:'noopener noreferrer',text:' Source'}):null);})),h('p',{class:'small',text:'Prepared drafts and sandbox captures are not external outreach. No message is authorized by research or an agreement review.'})));
      });
        /* END authorized 2026-11-06 recruitment evidence history. */
    });
  };

  function preparationPanel(p) {
    if(!p)return null;
    var names={marketing:'Marketing',pr:'Public Relations',affiliate:'Affiliate Recruitment'};
    return h('section',{class:'card',testid:'preparation-operations'},h('h2',{text:'Autonomous preparation — owner approval required'}),h('p',{class:'sub',text:p.receiptMeaning}),
      h('div',{class:'grid tiles'},Object.keys(names).map(function(k){var d=p.departments[k];return h('div',{class:'tile','data-department':k},h('h3',{text:names[k]}),h('p',{text:d.awaitingOwnerReview+' awaiting owner review · '+d.ready+' ready · '+d.held+' held · '+d.awaitingReceipt+' not yet checked'}),h('p',{class:'small',text:d.receipts+' preparation receipts (content versions); '+d.approvedDrafts+' owner-approved drafts'}));})),
      h('p',{text:'Preparation queue: '+(p.jobs.pending||0)+' pending · '+(p.jobs.retry||0)+' retrying · '+(p.jobs.running||0)+' running · '+(p.jobs.failed||0)+' historical failures · '+(p.jobs.completed||0)+' completed. These are distinct from scheduled runs and deliveries.'}),
      h('p',{text:'Observed real deliveries: '+p.realDeliveriesObserved+' · observed live social posts: '+p.liveSocialPostsObserved+' · paying conversion attribution: not connected in staging.'}),
      (p.recentJobs||[]).length?h('details',null,h('summary',{text:'Preparation job history and recovery'}),p.recentJobs.slice(0,12).map(function(j){return h('div',{class:'notice'},h('strong',{text:j.payload.department+' · '+j.state}),h('span',{text:' · '+j.attempts+' attempts · due '+expiryWhen(j.dueAt)}),j.lastError?h('p',{text:j.lastError}):null,j.state==='failed'?h('button',{class:'btn small',text:'Retry preparation job',onclick:function(){api('POST','/admin/preparation/jobs/'+encodeURIComponent(j.id)+'/requeue').then(route).catch(fail);}}):null);})):null);
  }
  pages.automation = function (main, params) {
    var alertState = params.alerts === 'all' ? 'all' : 'open';
    return Promise.all([api('GET', '/admin/status'), api('GET', '/admin/alerts?state=' + alertState), api('GET', '/admin/jobs?limit=40'), api('GET', '/admin/runs?limit=40'), api('GET', '/admin/suppressions?limit=100'), api('GET', '/admin/audit?limit=40')]).then(function (r) {
      var st = r[0], alerts = r[1].alerts, jobs = r[2].jobs, runs = r[3].runs, sup = r[4].suppressions, log = r[5].entries, sc = st.scheduler;
      if (alertState === 'open') state.alertCount = alerts.length;
      clear(main);
      var runNow = h('button', { class: 'btn primary', testid: 'btn-run-now', text: '▶ Run now', onclick: function () {
        modal({ title: 'Run the Growth Engine now?', confirmLabel: 'Run now', body: h('p', { text: INTEGRATED ? 'Run one sandbox cycle now. Every new draft requires owner approval. No real message or post will be sent.' : 'This runs one cycle immediately, exactly like the automatic 15-minute run. The same safety rules apply: nothing is sent or posted.' }),
          onConfirm: function () { return api('POST', '/admin/run-now'); } })
          .then(function (res) {
            if (!res) return;
            var s = res.summary || {};
            toast(s.skipped ? 'A run already happened this minute — try again in a minute.' : 'Run ' + s.runId + ' finished: ' + (s.jobs || []).filter(function (j) { return j.ok; }).length + ' job(s) done' + ((s.errors || []).length ? ', ' + s.errors.length + ' error(s)' : '') + '.', s.errors && s.errors.length ? 'bad' : 'good');
            route();
          }).catch(fail);
      } });
      var supEmail = h('input', { type: 'email', testid: 'optout-email', placeholder: 'name@example.com', maxlength: '254' });
      var supReason = h('input', { type: 'text', testid: 'optout-reason', placeholder: 'Reason (optional)', maxlength: '200' });
      var supForm = h('form', { class: 'filters', testid: 'optout-form', onsubmit: function (e) {
        e.preventDefault();
        api('POST', '/admin/suppressions', { address: supEmail.value.trim(), reason: supReason.value }).then(function () { toast('Added to the do-not-contact list.', 'good'); route(); }).catch(fail);
      } }, supEmail, supReason, h('button', { class: 'btn', type: 'submit', testid: 'btn-add-optout', text: 'Add to do-not-contact list' }));
      add(main, [
        head('Automation', 'The scheduler, background jobs, alerts and safety lists.', runNow),
        preparationPanel(st.preparation),
        h('div', { class: 'grid tiles' },
          h('div', { class: 'tile', testid: 'sched-tile' }, h('div', { class: 'label', text: 'Scheduler' }), h('div', { class: 'value text', text: sc.healthy ? 'Running' : 'Check' }), h('div', { class: 'hint', text: sc.schedule + ' · last run ' + when(sc.lastRunAt) })),
          h('div', { class: 'tile' }, h('div', { class: 'label', text: 'Runs in last 24 h' }), h('div', { class: 'value', text: fmtNum(sc.runsLast24h) }), h('div', { class: 'hint', text: 'About 96 expected per day' })),
          h('div', { class: 'tile', testid: 'delivery-tile' }, h('div', { class: 'label', text: 'Email delivery' }), h('div', { class: 'value', text: st.delivery.realDelivery ? 'ON' : 'OFF' }), h('div', { class: 'hint', text: 'Provider: ' + st.delivery.provider })),
          h('div', { class: 'tile' }, h('div', { class: 'label', text: 'Database' }), h('div', { class: 'value text', text: st.database.name }), h('div', { class: 'hint', text: st.database.hostPinned ? 'Host pinned ✓' : 'Host not pinned yet' }))),
        st.warnings && st.warnings.length ? h('div', { class: 'banner warn' }, h('span', { class: 'ico', text: '!' }), h('div', null, h('strong', { text: 'Configuration notes' }), st.warnings.join(' · '))) : null,
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { text: 'Alerts' }), h('div', { class: 'right' },
            h('button', { class: 'btn small' + (alertState === 'open' ? ' primary' : ''), testid: 'alerts-open', text: 'Open', onclick: function () { location.hash = '#/automation'; } }),
            h('button', { class: 'btn small' + (alertState === 'all' ? ' primary' : ''), testid: 'alerts-all', text: 'All', onclick: function () { location.hash = '#/automation?alerts=all'; } }))),
          alerts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'alerts-table' },
            h('thead', null, h('tr', null, h('th', { text: 'What happened' }), h('th', { text: 'When' }), h('th', { text: 'State' }), h('th', { text: '' }))),
            h('tbody', null, alerts.map(function (a) {
              return h('tr', { testid: 'alert-row', 'data-alert-key': a.alertKey }, h('td', null, h('strong', { text: a.kind + ': ' + a.id }), h('div', { class: 'small muted', text: a.error }),a.action?h('div',{class:'small',text:a.action}):null), h('td', { class: 'nowrap small', text: when(a.createdAt) }), h('td', null, chip(a.state)),
                h('td', null, a.requiresProviderRecovery ? h('a',{class:'btn small',href:'#/connections',text:'Review connection'}) : a.state === 'open' ? h('button', { class: 'btn small', testid: 'btn-ack', text: 'Acknowledge', onclick: function () {
                  api('POST', '/admin/alerts/' + encodeURIComponent(a.alertKey) + '/ack').then(function (res) { toast(res.ok ? 'Alert acknowledged.' : 'Already acknowledged.', 'good'); refreshCounts(); route(); }).catch(fail);
                } }) : h('span', { class: 'small muted', text: a.ackBy ? 'by ' + a.ackBy : '' })));
            })))) : h('div', { class: 'empty', testid: 'alerts-empty', text: alertState === 'open' ? 'No open alerts. Everything is running normally.' : 'No alerts recorded.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Background jobs' }), h('p', { class: 'sub', text: INTEGRATED ? (sc.schedulerEnabled ? 'Sandbox preparation runs on durable timers. New drafts await owner approval. Failed jobs retry automatically; no real delivery is enabled.' : 'Recorded sandbox jobs are processed during owner-started cycles. No automatic worker or real delivery is enabled.') : 'Daily discovery, follow-ups and the daily report. Failed jobs retry automatically up to 3 times; after that you can run them again.' }),
          jobs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'jobs-table' },
            h('thead', null, h('tr', null, h('th', { text: 'Job' }), h('th', { text: 'Due' }), h('th', { text: 'State' }), h('th', { class: 'num', text: 'Attempts' }), h('th', { text: '' }))),
            h('tbody', null, jobs.map(function (j) {
              return h('tr', { testid: 'job-row', 'data-job-id': j.id }, h('td', null, h('span', { class: 'mono', text: j.id }), j.lastError ? h('div', { class: 'small muted', text: j.lastError }) : null), h('td', { class: 'nowrap small', text: when(j.dueAt) }), h('td', null, chip(j.state)), h('td', { class: 'num', text: fmtNum(j.attempts) }),
                h('td', null, j.state === 'failed' ? h('button', { class: 'btn small', testid: 'btn-requeue', text: 'Run again', onclick: function () {
                  api('POST', '/admin/jobs/' + encodeURIComponent(j.id) + '/requeue').then(function () { toast('Job queued. It runs on the next automatic cycle (or press Run now).', 'good'); route(); }).catch(fail);
                } }) : null));
            })))) : h('div', { class: 'empty', text: 'No jobs yet.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Run history' }), h('p', { class: 'sub', text: 'Each row is one automatic (or manual) cycle.' }), runsTable(runs)),
        h('section', { class: 'card' }, h('h2', { text: 'Do-not-contact list' }), h('p', { class: 'sub', text: 'People who unsubscribed or that you added. The engine never emails them.' }), supForm,
          sup.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'optout-table' }, h('thead', null, h('tr', null, h('th', { text: 'Address' }), h('th', { text: 'Source' }), h('th', { text: 'Added' }))),
            h('tbody', null, sup.map(function (s) { return h('tr', { testid: 'optout-row' }, h('td', { text: s.address }), h('td', { text: s.source === 'link' ? 'Unsubscribe link' : 'Added by owner' }), h('td', { class: 'small', text: when(s.createdAt) })); })))) : h('div', { class: 'empty', text: 'Nobody has opted out.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Activity log' }), h('p', { class: 'sub', text: 'Every owner action is recorded.' }),
          log.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'audit-table' }, h('thead', null, h('tr', null, h('th', { text: 'When' }), h('th', { text: 'Action' }), h('th', { text: 'Item' }), h('th', { text: 'By' }))),
            h('tbody', null, log.map(function (e) { return h('tr', null, h('td', { class: 'nowrap small', text: when(e.at) }), h('td', { text: String(e.action || '').replace(/_/g, ' ') }), h('td', { class: 'mono', text: e.id || e.prospectId || '' }), h('td', { class: 'small', text: e.admin || '' })); })))) : h('div', { class: 'empty', text: 'No actions yet.' })),
      ]);
    });
  };

  function bars(rows, testid) {
    var max = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([1]));
    return h('div', { testid: testid }, rows.map(function (r) {
      var bar = h('div', { class: 'bar' }); bar.style.width = (r[1] / max * 100) + '%';
      return h('div', { class: 'bar-row', title: r[0] + ': ' + fmtNum(r[1]) }, h('span', { class: 'name', text: r[0] }), h('div', { class: 'bar-track' }, bar), h('span', { class: 'val', text: fmtNum(r[1]) }));
    }));
  }
  pages.analytics = function (main) {
    return Promise.all([api('GET', '/admin/analytics'), api('GET', '/admin/funnel')]).then(function (rr) { var r = rr[0]; var fun = rr[1].funnel; setTimeout(function () { var slot = document.getElementById('funnel-slot'); if (slot && !slot.firstChild) slot.appendChild(funnelCard(fun)); }, 0); return r; }).then(function (r) {
      var a = r.analytics; clear(main);
      var m = a.workstreams.matrix, vals = [];
      a.workstreams.departments.forEach(function (d) { a.workstreams.genres.forEach(function (g) { if (m[d][g] !== null) vals.push(m[d][g]); }); });
      var max = Math.max.apply(null, vals.concat([1]));
      var level = function (v) { if (v === null || v === 0) return 'l0'; var f = v / max; return f > 0.75 ? 'l4' : f > 0.5 ? 'l3' : f > 0.25 ? 'l2' : 'l1'; };
      var days = a.runs.byDay;
      var dmax = Math.max.apply(null, days.map(function (d) { return d.completed || 0; }).concat([1]));
      var byK = a.drafts.byGenreKind;
      add(main, [
        head('Analytics', 'Computed live from the production Growth database · ' + when(a.generatedAt)),
        h('div', { id: 'funnel-slot' }),
        h('div', { class: 'grid tiles' },
          tile('Items prepared', a.drafts.total, 'Posts & emails', '#/approvals?status=', 'an-total'),
          tile('Approval rate', a.drafts.approvalRate === null ? null : a.drafts.approvalRate, a.drafts.approvalRate === null ? 'Nothing decided yet' : '% of decided items approved', '#/approvals?status=', 'an-rate'),
          tile('Prospects', a.prospects.total, fmtNum(a.prospects.withVerifiedContact) + ' with verified contact', '#/pr', 'an-prospects'),
          tile('Workstreams (latest run)', a.workstreams.total, '5 sports × 5 departments', '#/analytics', 'an-workstreams'),
          tile('Runs, last 7 days', a.runs.last7Days, 'Automatic + manual', '#/automation', 'an-runs'),
          tile('Real emails sent', a.deliveries.real, 'Delivery is off in staging', '#/automation', 'an-real')),
        h('section', { class: 'card' }, h('h2', { text: 'What each department produced in the latest run' }), h('p', { class: 'sub', text: 'Run ' + (a.workstreams.runId || '—') + '. Audience = verified prospects found; Performance = verified tracking events measured (none in staging yet); other departments = drafts prepared. Darker = more.' }),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data matrix', testid: 'workstream-matrix' },
            h('thead', null, h('tr', null, h('th', { text: 'Department' }), a.workstreams.genres.map(function (g) { return h('th', { class: 'num', text: sport(g) }); }))),
            h('tbody', null, a.workstreams.departments.map(function (d) {
              return h('tr', null, h('td', { text: DEPT_NAMES[d] || d }), a.workstreams.genres.map(function (g) { var v = m[d][g]; return h('td', { class: 'cell ' + level(v), title: (DEPT_NAMES[d] || d) + ' · ' + sport(g) + ': ' + (v === null ? 'did not run' : fmtNum(v)), text: v === null ? '—' : fmtNum(v) }); }));
            })))),
          h('div', { class: 'legend' }, 'Fewer', ['l0', 'l1', 'l2', 'l3', 'l4'].map(function (l) { return h('i', { class: l }); }), 'More')),
        h('div', { class: 'grid two' },
          h('section', { class: 'card' }, h('h2', { text: 'Fight campaigns prepared, by sport' }), h('p', { class: 'sub', text: 'All time' }), bars(SPORTS.map(function (g) { return [sport(g), (byK[g] || {}).marketing || 0]; }), 'chart-marketing')),
          h('section', { class: 'card' }, h('h2', { text: 'Media & creator prospects, by sport' }), h('p', { class: 'sub', text: 'Podcasts, shows & creators (PR and affiliate candidates)' }), bars(SPORTS.map(function (g) { var x = a.prospects.byGenre[g] || {}; return [sport(g), (x.partners || 0) + (x.fans || 0)]; }), 'chart-partners'))),
        h('div', { class: 'grid two' },
          h('section', { class: 'card' }, h('h2', { text: 'Completed runs per day' }), h('p', { class: 'sub', text: 'Last 7 days' }),
            days.length ? h('div', { testid: 'chart-runs' },
              h('div', { class: 'vbars' }, days.map(function (d) { var c = h('div', { class: 'col' }); c.style.height = ((d.completed || 0) / dmax * 100) + '%'; return h('div', { class: 'vbar', title: d.day + ': ' + (d.completed || 0) + ' completed' }, h('span', { class: 'top', text: String(d.completed || 0) }), c); })),
              h('div', { class: 'vlabels' }, days.map(function (d) { return h('span', { text: d.day.slice(5) }); })),
              h('table', { class: 'data small' }, h('thead', null, h('tr', null, h('th', { text: 'Day' }), h('th', { class: 'num', text: 'Completed' }), h('th', { class: 'num', text: 'Failed' }), h('th', { class: 'num', text: 'Interrupted' }))),
                h('tbody', null, days.map(function (d) { return h('tr', null, h('td', { text: d.day }), h('td', { class: 'num', text: fmtNum(d.completed || 0) }), h('td', { class: 'num', text: fmtNum(d.failed || 0) }), h('td', { class: 'num', text: fmtNum(d.stale || 0) })); }))))
              : h('div', { class: 'empty', text: 'No runs in the last 7 days.' })),
          h('section', { class: 'card' }, h('h2', { text: 'Approval funnel' }), h('p', { class: 'sub', text: 'Where every prepared item stands' }),
            bars([['Awaiting approval', a.drafts.byStatus.needs_owner_review || 0], ['Approved', a.drafts.byStatus.approved || 0], ['Published', a.drafts.byStatus.published || 0], ['Delivered', a.drafts.byStatus.delivered || 0], ['Rejected', a.drafts.byStatus.rejected || 0]], 'chart-funnel'))),
        h('section', { class: 'card' }, h('h2', { text: 'Daily reports' }), h('p', { class: 'sub', text: 'One snapshot saved per day by the engine' }),
          a.reports.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'reports-table' },
            h('thead', null, h('tr', null, h('th', { text: 'Day' }), h('th', { class: 'num', text: 'Prospects' }), h('th', { class: 'num', text: 'Marketing' }), h('th', { class: 'num', text: 'PR' }), h('th', { class: 'num', text: 'Affiliate' }), h('th', { class: 'num', text: 'Open alerts' }))),
            h('tbody', null, a.reports.map(function (x) { var k = x.draftsByKind || {}; return h('tr', null, h('td', { text: String(x.day).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') }), h('td', { class: 'num', text: fmtNum(x.prospects) }), h('td', { class: 'num', text: fmtNum(k.marketing || 0) }), h('td', { class: 'num', text: fmtNum(k.pr || 0) }), h('td', { class: 'num', text: fmtNum(k.affiliate || 0) }), h('td', { class: 'num', text: fmtNum(x.openAlerts) })); })))) : h('div', { class: 'empty', text: 'No daily reports yet.' })),
      ]);
    });
  };

  pages.revenue = function (main) {
    return api('GET', '/admin/attribution').then(function (r) {
      var a = r.attribution; clear(main);
        /* BEGIN authorized 2026-11-06 revenue QA separation. */
      a.synthetic = null;
        /* END authorized 2026-11-06 revenue QA separation. */
      var rejected = Object.keys(a.rejectedEvents || {});
      add(main, [
        head('Revenue Attribution', 'Which campaigns and affiliates bring in paying players.'),
        a.synthetic ? syntheticCard(a.synthetic) : null,
        h('div', { class: 'banner warn', testid: 'payment-banner' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: '!' }), h('div', null, h('strong', { text: 'Live payment attribution is not connected to Growth.' }), a.paymentSource.note + ' Connecting real payment data needs your approval.')),
        h('div', { class: 'grid tiles' },
          h('div', { class: 'tile', testid: 'rev-total' }, h('div', { class: 'label', text: 'Credited revenue' }), h('div', { class: 'value', text: money(a.totalRevenueCents) }), h('div', { class: 'hint', text: 'Verified, settled payments only' })),
          h('div', { class: 'tile', testid: 'rev-entries' }, h('div', { class: 'label', text: 'Paid entries credited' }), h('div', { class: 'value', text: fmtNum(a.creditedEntries) }), h('div', { class: 'hint', text: 'Duplicates never counted' })),
          h('div', { class: 'tile' }, h('div', { class: 'label', text: 'Verified visits' }), h('div', { class: 'value', text: fmtNum(a.funnel.visits) }), h('div', { class: 'hint', text: 'From tracked links' })),
          h('div', { class: 'tile' }, h('div', { class: 'label', text: 'Verified sign-ups' }), h('div', { class: 'value', text: fmtNum(a.funnel.signups) }), h('div', { class: 'hint', text: fmtNum(a.funnel.unverifiedExcluded) + ' unverified event' + (a.funnel.unverifiedExcluded === 1 ? '' : 's') + ' excluded' }))),
        h('section', { class: 'card' }, h('h2', { text: 'Revenue by sport' }),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'rev-by-sport' }, h('thead', null, h('tr', null, h('th', { text: 'Sport' }), h('th', { class: 'num', text: 'Paid entries' }), h('th', { class: 'num', text: 'Revenue' }))),
            h('tbody', null, a.byGenre.map(function (x) { return h('tr', null, h('td', { text: sport(x.genre) }), h('td', { class: 'num', text: fmtNum(x.paidEntries) }), h('td', { class: 'num', text: money(x.revenueCents) })); }))))),
        h('section', { class: 'card' }, h('h2', { text: 'Affiliates and tracked links' }), h('p', { class: 'sub', text: 'Active affiliates (joined the live program). Links use the live site’s own referral code, so the live site credits their players.' }),
          a.affiliates.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'rev-affiliates' }, h('thead', null, h('tr', null, h('th', { text: 'Affiliate' }), h('th', { text: 'Sport' }), h('th', { text: 'Tracked link' }), h('th', { class: 'num', text: 'Paid entries' }), h('th', { class: 'num', text: 'Revenue' }))),
            h('tbody', null, a.affiliates.map(function (x) {
              return h('tr', { testid: 'rev-affiliate-row' }, h('td', null, h('strong', { text: x.name }), ' ', x.status === 'approved' ? h('span', { class: 'chip good', text: '✓ Approved' }) : h('span', { class: 'chip warn', text: 'Pending' })), h('td', { text: sport(x.genre) }),
                h('td', null, x.trackingLink ? [h('span', { class: 'mono', text: 'fantasymmadness.com' + x.trackingLink }), ' ', h('button', { class: 'btn small', testid: 'btn-copy-link', text: 'Copy', onclick: function () { copyText('https://fantasymmadness.com' + x.trackingLink); } })] : h('span', { class: 'muted', text: '—' })),
                h('td', { class: 'num', text: fmtNum(x.paidEntries) }), h('td', { class: 'num', text: money(x.revenueCents) }));
            })))) : h('div', { class: 'empty', testid: 'rev-affiliates-empty', text: 'No active affiliates yet. An affiliate appears here once they join the live affiliate program and you link their live affiliate ID on the Affiliate Recruitment page.' })),
        h('section', { class: 'card' }, h('h2', { text: 'How revenue is credited' }),
          h('ul', { class: 'small' },
            h('li', { text: 'Only payments confirmed by the server as settled count. Browser analytics never count as revenue.' }),
            h('li', { text: 'The paying player must have arrived through that affiliate’s tracked link, for that fight.' }),
            h('li', { text: 'Each paid entry is credited once. Duplicates and payments that have not settled are excluded.' })),
          h('p', { class: 'small muted', testid: 'rev-events', text: fmtNum(a.eventsRecorded) + ' tracking events recorded in staging' + (rejected.length ? ' · not credited: ' + rejected.map(function (k) { return k.replace(/_/g, ' ') + ' (' + a.rejectedEvents[k] + ')'; }).join(', ') : '') + '.' })),
      ]);
    });
  };

  // Controlled live test (owner-authorized, one real post per channel).
  function liveTestCard(r) {
    var card = h('section', { class: 'card', testid: 'live-test' }, h('h2', { text: 'Controlled live test (Facebook & Instagram)' }));
    if (!r.liveTestApproved) {
      add(card, [h('p', { text: 'Real posting is OFF. All posts are simulated (sandbox) until you explicitly authorize one controlled live test.' }), h('p', { class: 'small muted', text: 'When you authorize it, this panel lets you publish ONE approved fight post to Facebook and ONE to Instagram through your connected accounts, after a final check.' })]);
      return card;
    }
    var pick = h('select', { testid: 'live-test-draft', 'aria-label': 'Approved fight campaign' }, h('option', { value: '', text: 'Loading approved campaigns…' }));
    var ch = h('select', { testid: 'live-test-channel', 'aria-label': 'Channel' }, [['facebook', 'Facebook Page'], ['instagram', 'Instagram']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var confirm = h('input', { type: 'text', testid: 'live-test-confirm', placeholder: 'Type POST LIVE', autocomplete: 'off' });
    var btn = h('button', { class: 'btn danger', testid: 'btn-live-test', text: 'Publish one live test post', onclick: function () {
      btn.disabled = true;
      api('POST', '/admin/social/live-test', { draftId: pick.value, channel: ch.value, confirmText: confirm.value }).then(function (x) { toast('Published live' + (x.post && x.post.url ? ': ' + x.post.url : '.'), 'good'); route(); })
        .catch(function (e) { btn.disabled = false; fail(e); });
    } });
    api('GET', '/admin/drafts?kind=marketing&status=approved&limit=50').then(function (x) {
      clear(pick); (x.drafts || []).forEach(function (d) { pick.appendChild(h('option', { value: d.id, text: (d.headline || d.id).slice(0, 90) })); });
      if (!pick.children.length) pick.appendChild(h('option', { value: '', text: 'No approved fight campaigns yet' }));
    }).catch(function () { /* shown empty */ });
    add(card, [h('div', { class: 'banner warn' }, h('span', { class: 'ico', text: '!' }), h('div', null, h('strong', { text: 'Live test authorized.' }), 'This posts publicly on your real account. One test per channel.')),
      h('label', { class: 'field' }, h('span', { text: 'Approved fight campaign' }), pick), h('label', { class: 'field' }, h('span', { text: 'Channel' }), ch), h('label', { class: 'field' }, h('span', { text: 'Type POST LIVE to confirm' }), confirm), btn]);
    return card;
  }

  // Facebook Page + Instagram connection (Meta sign-in; tokens stay on the server).
  function metaModeChip(label, mode) { return h('span', { class: 'chip ' + (mode === 'live' ? 'good' : mode === 'sandbox' ? 'info' : ''), testid: 'meta-mode-' + label.toLowerCase(), text: label + ': ' + (mode === 'live' ? 'Live' : mode === 'sandbox' ? 'Sandbox' : 'Off') }); }
  function existingMetaCard(m) {
    var card = h('section', { class: 'card', testid: 'meta-card' }, h('h2', { text: 'Facebook & Instagram · existing connection' }), h('p', { text: 'Reuses the existing authorized configuration. Publishing is disabled; verification does not renew or change credentials.' }));
    ['facebook', 'instagram'].forEach(function (platform) { var x = m.platforms[platform];card.appendChild(h('div', { testid: 'meta-existing-' + platform }, h('h3', { text: platform === 'facebook' ? 'Facebook Page' : 'Instagram account' }), h('span', { class: 'chip ' + (x.verified ? 'good' : 'warn'), text: x.verified ? 'Verified existing connection' : 'Verification unresolved' }), h('p', { text: x.verified ? (x.username ? '@' + x.username : x.name || '') + ' · ID: ' + x.id : x.reason }))); });
    card.appendChild(h('p', { class: 'small', text: 'Source: ' + m.source + ' · checked: ' + when(m.health.checkedAt) }));
    card.appendChild(h('button', { class: 'btn small', testid: 'btn-meta-check', text: 'Verify existing Facebook & Instagram', onclick: function () { api('POST', '/admin/meta/check').then(route).catch(fail); } }));
    return card;
  }
  function metaCard(m) {
    if (m.readOnlyExisting) return existingMetaCard(m);
    var card = h('section', { class: 'card', testid: 'conn-meta', 'data-state': m.state });
    var list = function (items) { return h('ul', { class: 'checklist' }, items.map(function (it) { return h('li', { class: it.done ? 'done' : 'todo' }, h('span', { 'aria-hidden': 'true', text: it.done ? '✓ ' : '○ ' }), it.text); })); };
    var stateChip = h('span', { class: 'chip ' + (m.state === 'connected' ? 'good' : 'warn'), testid: 'meta-state', text: (m.state === 'connected' ? '✓ ' : '') + m.connectionLabel });
    add(card, [h('h2', { text: 'Facebook & Instagram' }), h('div', { class: 'conn-row' }, stateChip, ' ', metaModeChip('Facebook', m.publishing.facebook), ' ', metaModeChip('Instagram', m.publishing.instagram))]);
    card.appendChild(h('p', { class: 'small muted', text: m.publishing.provider === 'live' ? 'Publishing mode: live (only owner-approved fight posts).' : 'Publishing mode: sandbox. Posts are checked and simulated; nothing reaches your accounts until you authorize a controlled live test.' }));
    var connectBtn = function (label) { return h('button', { class: 'btn primary', testid: 'btn-meta-connect', text: label || 'Connect Facebook & Instagram', onclick: function () { metaConnect(); } }); };
    if (m.state === 'not_set_up') {
      card.appendChild(list(m.setup));
      if (m.setup[0].done && !m.setup[1].done) {
        var appId = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', testid: 'meta-app-id' });
        var appSecret = h('input', { type: 'password', autocomplete: 'off', testid: 'meta-app-secret' });
        var cfgId = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', testid: 'meta-config-id' });
        add(card, [h('p', { text: 'Enter your Meta app’s App ID and App Secret (Meta for Developers → your app → App settings → Basic). They are stored encrypted and never shown again.' }),
          h('label', { class: 'field' }, h('span', { text: 'App ID' }), appId), h('label', { class: 'field' }, h('span', { text: 'App Secret' }), appSecret),
          h('label', { class: 'field' }, h('span', { text: 'Login configuration ID (only if your app has one)' }), cfgId, h('small', { text: 'Facebook Login for Business → Configurations. Leave empty if you did not create one.' })),
          h('button', { class: 'btn primary', testid: 'btn-meta-app-save', text: 'Save and check with Meta', onclick: function () {
            api('POST', '/admin/meta/app', { appId: appId.value, appSecret: appSecret.value, loginConfigId: cfgId.value }).then(function (x) { appSecret.value = ''; toast('Meta app saved' + (x.appName ? ': ' + x.appName : '') + '.', 'good'); route(); }).catch(fail);
          } })]);
      }
      add(card, [h('p', { class: 'small', text: 'In the Meta app, add this exact address under Facebook Login → Settings → Valid OAuth Redirect URIs:' }), h('code', { class: 'copy', testid: 'meta-redirect-uri', text: m.redirectUri })]);
      return card;
    }
    if (m.state === 'authorization_needed') {
      var why = [].concat(m.missingPermissions.length ? ['Permissions not granted: ' + m.missingPermissions.join(', ')] : [], (m.health && m.health.problems) || [], m.lastError ? ['Last attempt: ' + m.lastError.reason] : []);
      add(card, [h('p', { text: m.authorizedAt ? 'Meta needs you to sign in again.' : 'Sign in with Meta to let the Growth Engine post your approved fight campaigns to your Facebook Page and Instagram account. You choose the Page in the next step.' }),
        why.length ? list(why.map(function (t) { return { done: false, text: t }; })) : null, connectBtn(m.authorizedAt ? 'Connect again' : null)]);
      return card;
    }
    if (m.state === 'selection_needed' || m.choosing) return pageChooser(card, m);
    // connected
    var s = m.selected; var hl = m.health || {};
    add(card, [
      h('dl', { class: 'facts', testid: 'meta-connected' },
        h('dt', { text: 'Facebook Page' }), h('dd', { testid: 'meta-page', text: s.pageName + ' (ID ' + s.pageId + ')' }),
        h('dt', { text: 'Instagram account' }), h('dd', { testid: 'meta-ig', text: '@' + s.igUsername + ' (ID ' + s.igUserId + ')' }),
        h('dt', { text: 'Signed in to Meta as' }), h('dd', { text: (m.user && m.user.name) || '—' }),
        h('dt', { text: 'Confirmed by' }), h('dd', { text: s.confirmedBy + ', ' + when(s.confirmedAt) }),
        h('dt', { text: 'Last health check' }), h('dd', { testid: 'meta-health', text: hl.checkedAt ? (hl.ok ? '✓ OK, ' : '✕ Problem, ') + when(hl.checkedAt) : 'not yet' }),
        h('dt', { text: 'Page access renewed' }), h('dd', { text: m.pageTokensRenewedAt ? when(m.pageTokensRenewedAt) : '—' }),
        h('dt', { text: 'Sign in again by' }), h('dd', { text: m.dataAccessExpiresAt || m.userTokenExpiresAt ? (m.dataAccessExpiresAt || m.userTokenExpiresAt).slice(0, 10) : 'not set by Meta' })),
      (hl.warnings || []).length ? list(hl.warnings.map(function (t) { return { done: false, text: t }; })) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', testid: 'btn-meta-check', text: 'Check now', onclick: function () { api('POST', '/admin/meta/check').then(function (x) { toast(x.check.ok ? 'Connection is healthy.' : 'Problem: ' + (x.check.problems || [])[0], x.check.ok ? 'good' : 'bad'); route(); }).catch(fail); } }),
        h('button', { class: 'btn small', testid: 'btn-meta-change', text: 'Change Page', onclick: function () { clear(card); m.choosing = true; card.replaceWith(metaCard(m)); } }),
        connectBtn('Reconnect'),
        h('button', { class: 'btn small danger', testid: 'btn-meta-disconnect', text: 'Disconnect', onclick: function () {
          modal({ title: 'Disconnect Facebook & Instagram?', confirmLabel: 'Disconnect', confirmClass: 'danger', body: h('p', { text: 'The Growth Engine forgets the sign-in and asks Meta to remove its access. Scheduled posts are held until you connect again.' }),
            onConfirm: function () { return api('POST', '/admin/meta/disconnect'); } }).then(function (ok) { if (ok) { toast('Disconnected.', 'good'); route(); } }).catch(fail);
        } })),
    ]);
    return card;
  }
  function pageChooser(card, m) {
    var chosen = null; var radios = [];
    var rows = (m.pages || []).map(function (p) {
      var ok = p.canPost && p.ig; var r = h('input', { type: 'radio', name: 'meta-page', value: p.id, disabled: !ok, testid: 'meta-page-option' }); radios.push(r);
      r.addEventListener('change', function () { chosen = p.id; });
      if (m.selected && m.selected.pageId === p.id && ok) { r.checked = true; chosen = p.id; }
      return h('label', { class: 'check-row page-option', 'data-page-id': p.id }, r, ' ', h('strong', { text: p.name }), ' ',
        p.ig ? h('span', { class: 'chip info', text: 'Instagram: @' + (p.ig.username || p.ig.id) }) : h('span', { class: 'chip warn', text: 'No Instagram professional account linked' }),
        !p.canPost ? h('span', { class: 'chip warn', text: 'You cannot post on this Page' }) : null);
    });
    var confirm = h('input', { type: 'checkbox', testid: 'meta-confirm' });
    add(card, [h('p', { text: 'Choose the FANTASY MMADNESS business Page. Its linked Instagram professional account is used for Instagram.' }),
      rows.length ? h('div', { class: 'field', testid: 'meta-pages' }, rows) : h('div', { class: 'empty', text: 'Meta returned no Pages. Connect again and select the FANTASY MMADNESS Page on Meta’s screen.' }),
      h('label', { class: 'check-row' }, confirm, ' This is the FANTASY MMADNESS business Facebook Page and its Instagram account.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', testid: 'btn-meta-select', text: 'Use this Page', onclick: function () {
        if (!chosen) return toast('Choose a Page first.', 'bad');
        api('POST', '/admin/meta/select', { pageId: chosen, confirm: confirm.checked }).then(function () { toast('Facebook & Instagram connected.', 'good'); route(); }).catch(fail);
      } }), h('button', { class: 'btn small', testid: 'btn-meta-connect', text: 'Connect again', onclick: function () { metaConnect(); } }))]);
    return card;
  }
  var metaPoll = null;
  function metaConnect() {
    // Open the window first (inside the click) so pop-up blockers allow it, then send it to Meta.
    var w = null; try { w = window.open('', 'fmm-meta-connect', 'popup=yes,width=620,height=760'); } catch (e) { w = null; }
    api('POST', '/admin/meta/connect').then(function (x) {
      if (w && !w.closed) { try { w.opener = window; } catch (e) { /* ignore */ } w.location.href = x.authorizeUrl; }
      else modal({ title: 'Open Meta sign-in', confirmLabel: 'Done', body: h('p', null, 'Your browser blocked the sign-in window. ', h('a', { href: x.authorizeUrl, target: '_blank', rel: 'opener', testid: 'meta-authorize-link', text: 'Open Meta sign-in' }), ', then come back here.'), onConfirm: function () { return Promise.resolve(true); } }).then(function () { route(); });
      var start = Date.now(); var before = null;
      clearInterval(metaPoll);
      api('GET', '/admin/meta').then(function (y) { before = y.meta.authorizedAt; });
      metaPoll = setInterval(function () {
        if (Date.now() - start > 5 * 60000) return clearInterval(metaPoll);
        api('GET', '/admin/meta').then(function (y) { if (y.meta.authorizedAt && y.meta.authorizedAt !== before) { clearInterval(metaPoll); toast('Meta sign-in received.', 'good'); if (/^#\/connections/.test(location.hash)) route(); } }).catch(function () {});
      }, 3000);
    }).catch(function (e) { if (w && !w.closed) w.close(); fail(e); });
  }
  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || !event.data || event.data.type !== 'fmm-meta-connect') return;
    clearInterval(metaPoll); if (/^#\/connections/.test(location.hash)) route();
  });

  pages.publishing = function (main) {
    return api('GET', '/admin/social').then(function (r) {
      clear(main);
      var names = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', tiktok: 'TikTok',youtube_shorts:'YouTube Shorts (draft)' };
      var paused = r.paused.paused;
      var toggle = h('button', { class: 'btn ' + (paused ? 'approve' : 'danger'), testid: 'btn-toggle-pause', text: paused ? '▶ Resume publishing' : '⏸ Pause all publishing', onclick: function () {
        modal({ title: paused ? 'Resume publishing?' : 'Pause all publishing?', confirmLabel: paused ? 'Resume' : 'Pause', confirmClass: paused ? 'approve' : 'danger',
          body: h('p', { text: paused ? 'Scheduled posts that are due will go out on the next run (every 15 minutes), after their fight is checked again.' : 'Nothing will be posted to any channel until you resume. Scheduled posts stay in the queue.' }),
          onConfirm: function () { return api('POST', '/admin/social/pause', { paused: !paused }); } }).then(function (ok) { if (ok) { toast(paused ? 'Publishing resumed.' : 'Publishing paused.', 'good'); route(); } }).catch(fail);
      } });
      if (PRODUCTION) { toggle.disabled = true; toggle.title = 'Publishing infrastructure requires a verified delivery release.'; }
      var rows = r.posts.map(function (p) {
        var acts = h('td', { class: 'nowrap' });
        if (['scheduled', 'held', 'failed'].indexOf(p.status) >= 0) acts.appendChild(h('button', { class: 'btn small danger', testid: 'btn-cancel-post', text: 'Cancel', onclick: function () { api('POST', '/admin/social/' + encodeURIComponent(p.id) + '/cancel').then(function () { toast('Post cancelled.', 'good'); route(); }).catch(fail); } }));
        if (['held', 'failed'].indexOf(p.status) >= 0) acts.appendChild(h('button', { class: 'btn small', testid: 'btn-retry-post', text: 'Retry', onclick: function () { api('POST', '/admin/social/' + encodeURIComponent(p.id) + '/retry', {}).then(function () { toast('Queued again for the next run.', 'good'); route(); }).catch(fail); } }));
        if (p.status === 'needs_check') acts.appendChild(h('button', { class: 'btn small', testid: 'btn-check-post', text: 'I checked: not posted', onclick: function () {
          var box = h('input', { type: 'checkbox', testid: 'confirm-not-live' });
          modal({ title: 'Was this post published?', confirmLabel: 'Queue it again', body: h('div', null, h('p', { text: 'Publishing was interrupted, so the post may already be live on ' + (names[p.channel] || p.channel) + '. Open the channel and look for it first.' }), h('label', { class: 'check-row' }, box, ' I checked the channel and this post is NOT there.')),
            onConfirm: function () { return api('POST', '/admin/social/' + encodeURIComponent(p.id) + '/retry', { confirmNotPublished: box.checked }); } }).then(function (ok) { if (ok) { toast('Queued again.', 'good'); route(); } }).catch(fail);
        } }));
        return h('tr', { testid: 'post-row', 'data-post-id': p.id, 'data-status': p.status },
          h('td', null, h('strong', { text: names[p.channel] || p.channel }), p.sandbox ? h('div', null, h('span', { class: 'chip info', text: 'Sandbox (simulated)' })) : p.status === 'published' ? h('div', null, h('span', { class: 'chip good', text: p.liveTest ? 'Live test' : 'Live' })) : null, p.affiliate ? h('div', { class: 'small muted', testid: 'post-affiliate', text: 'Credits ' + p.affiliate.name }) : null),
          h('td', null, h('div', { class: 'small', text: (p.text || '').split('\n')[0] }), h('div', { class: 'small muted', text: sport(p.genre) })),
          h('td', { class: 'nowrap small', text: when(p.publishedAt || p.scheduledAt) }),
          h('td', null, chip(p.status), p.heldReason ? h('div', { class: 'small muted', text: p.heldReason }) : null, p.lastError ? h('div', { class: 'small muted', text: p.lastError }) : null, p.cancelReason ? h('div', { class: 'small muted', text: friendly(p.cancelReason) }) : null, p.preflight && p.preflight.length ? h('div', { class: 'small muted', text: 'Checked: ' + p.preflight.join('; ') }) : null, p.history ? h('details', { class: 'small' }, h('summary', { text: 'Log' }), h('ul', null, p.history.map(function (x) { return h('li', { text: when(x.at) + ' · ' + x.status + (x.by ? ' · ' + x.by : '') + (x.note ? ' · ' + x.note : '') }); }))) : null, p.pending ? h('div', { class: 'small muted', text: p.pending === 'in_tiktok_inbox_as_draft' ? 'In your TikTok inbox as a draft: finish posting in the app.' : 'Processing at TikTok.' }) : null, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', text: 'View post' }) : null),
          acts);
      });
      add(main, [
        head('Publishing', 'Scheduled social posts for approved fight campaigns. Nothing posts without your approval, and every fight is checked again just before posting.', toggle),
        paused ? h('div', { class: 'banner warn', testid: 'paused-banner' }, h('span', { class: 'ico', text: '⏸' }), h('div', null, h('strong', { text: 'Publishing is paused.' }), 'Nothing will be posted until you resume.' + (r.paused.by ? ' Paused by ' + r.paused.by + '.' : ''))) : null,
        h('section', { class: 'card' }, h('h2', { text: 'Channels' }), h('p', { class: 'sub', text: 'Mode: ' + (r.provider === 'none' ? 'off (posts are held)' : r.provider === 'sandbox' ? 'sandbox: posting is simulated, nothing reaches the real accounts' : 'live') }),
          h('div', { class: 'grid tiles' }, Object.keys(names).map(function (ch) { var c = r.channels[ch] || {}; return h('div', { class: 'tile', testid: 'channel-tile-' + ch }, h('div', { class: 'label', text: names[ch] }), h('div', { class: 'value text', text: PRODUCTION ? (c.connected ? 'Connected' : 'Verification needed') : c.mode === 'live' ? 'Live' : c.mode === 'sandbox' ? 'Sandbox' : 'Off' }), h('div', { class: 'hint', text: PRODUCTION ? (c.note || 'Publishing disabled. Connection verification unavailable.') : c.ready ? (c.note || (c.mode === 'sandbox' ? 'Simulated: nothing reaches the account' : 'Ready')) : 'Authorization needed: see Connections' })); }))),
        /* BEGIN authorized 2026-11-06 publishing QA separation. */
        false &&
        /* END authorized 2026-11-06 publishing QA separation. */
        liveTestCard(r),
        h('section', { class: 'card' }, h('h2', { text: 'Queue' }), rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'posts-table' }, h('thead', null, h('tr', null, h('th', { text: 'Channel' }), h('th', { text: 'Post' }), h('th', { text: 'When' }), h('th', { text: 'Status' }), h('th', { text: '' }))), h('tbody', null, rows)))
          : h('div', { class: 'empty', testid: 'posts-empty', text: 'Nothing scheduled. Approve a fight campaign, then press “Schedule posts”.' })),
      ]);
    });
  };

  // Sandbox outbox: approved emails built exactly as they would be sent, never sent.
  function sandboxOutbox(sb) {
    var card = h('section', { class: 'card', testid: 'sandbox-outbox' }, h('h2', { text: 'Sandbox outbox (nothing is sent)' }));
    if (!sb) { card.appendChild(h('p', { class: 'muted', text: 'Could not load the sandbox outbox right now.' })); return card; }
    if (sb.provider !== 'sandbox-capture') { card.appendChild(h('p', { class: 'muted', text: 'Email mode: ' + sb.provider + '. Approved emails are held (not built or sent).' })); return card; }
    card.appendChild(h('p', { class: 'sub', text: sb.count + ' approved email' + (sb.count === 1 ? '' : 's') + ' built exactly as they would be sent (from contact@fantasymmadnesscom.com, with unsubscribe), then stored here. None were sent.' }));
    if (!sb.messages.length) { card.appendChild(h('div', { class: 'empty', text: 'Approve a PR or affiliate email to see it here.' })); return card; }
    var tbody = h('tbody');
    sb.messages.forEach(function (m) {
      var prev = h('tr', { class: 'preview-row' }); prev.hidden = true; var cell = h('td', { colspan: '4' }); prev.appendChild(cell);
      tbody.appendChild(h('tr', { testid: 'sandbox-mail', 'data-receipt': m.id },
        h('td', null, h('strong', { text: m.message.to.join(', ') }), h('div', { class: 'small muted', text: (KIND_NAMES[m.kind] || m.kind || '') + ' · ' + when(m.capturedAt) })),
        h('td', { class: 'small', text: m.message.subject }),
        h('td', null, m.checks.every(function (x) { return x.ok; }) ? h('span', { class: 'chip good', text: '✓ Checks passed' }) : h('span', { class: 'chip bad', text: 'Check failed: ' + m.checks.filter(function (x) { return !x.ok; }).map(function (x) { return x.name; }).join(', ') }), h('div', { class: 'small muted', text: 'Receipt ' + m.id + ' · not sent' })),
        h('td', null, h('button', { class: 'btn small', testid: 'btn-sandbox-preview', text: 'View', onclick: function (ev) { if (!prev.hidden) { prev.hidden = true; clear(cell); ev.target.textContent = 'View'; return; } cell.appendChild(emailPreview(m.message.html)); prev.hidden = false; ev.target.textContent = 'Hide'; } }))));
      tbody.appendChild(prev);
    });
    card.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'To' }), h('th', { text: 'Subject' }), h('th', { text: 'Checks' }), h('th', { text: '' }))), tbody)));
    return card;
  }

  pages.connections = function (main) {
    return Promise.all([api('GET', '/admin/connections'), api('GET', '/admin/email/readiness').catch(function () { return { readiness: null }; }), api('GET', '/admin/email/sandbox?limit=20').catch(function () { return null; })]).then(function (r) {
      var c = r[0].connections, e = r[1].readiness, sb = r[2]; clear(main);
      var names = { facebook: 'Facebook Page', instagram: 'Instagram business account', x: 'X account', tiktok: 'TikTok account' };
      var list = function (items) { return h('ul', { class: 'checklist' }, items.map(function (it) { return h('li', { class: it.done ? 'done' : 'todo' }, h('span', { 'aria-hidden': 'true', text: it.done ? '✓ ' : '○ ' }), it.text); })); };
      add(main, [
        head('Connections', 'What the Growth Engine is connected to, and exactly what is still needed. Nothing here can send or post on its own.'),
        INTEGRATED ? oauthCards() : null,
        metaCard(c.meta),
        h('section', { class: 'card', testid: 'conn-social' }, h('h2', { text: 'Other social channels' }), h('p', { class: 'sub', text: 'Mode: ' + c.social.provider + (c.social.paused.paused ? ' · paused' : '') }),
          ['x', 'tiktok'].map(function (ch) { var x = c.social.channels[ch]; return h('div', { class: 'conn-row' }, h('strong', { text: names[ch] }), ' ', x.mode === 'live' ? h('span', { class: 'chip good', text: '✓ Live' }) : x.mode === 'sandbox' ? h('span', { class: 'chip info', text: 'Sandbox' }) : h('span', { class: 'chip', text: 'Off' }), x.blockers.length ? list(x.blockers.map(function (b) { return { done: false, text: b }; })) : null, x.note ? h('p', { class: 'small muted', text: x.note }) : null); })),
        h('section', { class: 'card', testid: 'conn-email' }, h('h2', { text: 'Business email (PR and affiliate invitations)' }), h('p', { class: 'sub', text: 'Sender: ' + c.email.sender + ' · real sending: ' + (c.email.realDelivery ? 'ON' : 'OFF') }),
          e ? list(e.steps) : h('p', { class: 'muted', text: 'Could not run the email check right now.' }),
          e && e.dns.error ? h('p', { class: 'small muted', text: 'DNS lookup problem: ' + e.dns.error }) : null),
        sandboxOutbox(sb),
        h('section', { class: 'card', testid: 'conn-results' }, h('h2', { text: 'Registrations and paying players' }),
          list([
            { done: true, text: 'Every Growth Engine link carries the campaign tag the live site already records when someone registers' },
            { done: c.liveRegistrationReport.configured, text: 'Read-only live registration report connected' + (c.liveRegistrationReport.latest ? ' (last pulled ' + c.liveRegistrationReport.latest.day + ')' : '') },
            { done: c.verifiedEventIngest.configured, text: c.verifiedEventIngest.previewBlocked ? 'Signed financial/event ingestion is disabled in this isolated Preview' : 'Signed event channel ready for verified registrations and settled paid entries (' + c.verifiedEventIngest.path + ')' },
          ])),
        h('section', { class: 'card' }, h('h2', { text: 'Fight contest list' }), h('p', { class: 'small', text: 'Read-only: ' + c.contestFeed.url }), h('span', { class: 'chip good', text: '✓ Connected' })),
      ]);
    });
  };

  // ---------- router ----------
  function parse() {
    var raw = (location.hash || '#/overview').slice(2); var i = raw.indexOf('?');
    var name = i >= 0 ? raw.slice(0, i) : raw; var params = {};
    if (i >= 0) raw.slice(i + 1).split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    return { name: pages[name] ? name : 'overview', params: params };
  }
  function route() {
    if (!token()) return renderLogin();
    var r = parse(); var main = shell(r.name); tellParent(r.name);
    document.title = (NAV.filter(function (n) { return n[0] === r.name; })[0] || ['', 'Growth Engine'])[1] + ' · Growth Engine (production preparation)';
    Promise.resolve(pages[r.name](main, r.params)).then(function () {
      if(PRODUCTION){
        main.prepend(h('div',{class:'banner info',testid:'production-preparation-banner'},h('strong',{text:'Production Growth preparation'}),h('span',{text:'Discovery, research and drafts only. Owner approval required; publishing, outreach and payment changes are disabled.'}),h('button',{class:'btn danger',testid:'production-emergency-stop',text:'Emergency stop preparation',onclick:function(){modal({title:'Stop production preparation?',body:h('p',{text:'This pauses scheduled preparation. Existing records and connections remain unchanged.'}),onConfirm:function(){return api('POST','/admin/autonomy/stop',{});}}).then(route).catch(fail);}})));
        main.querySelectorAll('button').forEach(function(b){if(/approve|publish|send|connect|disconnect|refresh.*token|generate|record correction|reject prospect|opt out|run now|check for new|check now|verify existing|add to do-not|invitation|onboard|mark|retry|requeue/i.test(b.textContent)){b.disabled=true;b.title='Requires a separately authorized operation; production preparation remains active.';}});
      }
 if (state.pendingCount === null) refreshCounts(); else paintBadges(); })
      .catch(function (e) { if (e && e.silent) return; clear(main).appendChild(h('div', { class: 'banner bad', testid: 'page-error' }, h('span', { class: 'ico', text: '!' }), h('div', null, h('strong', { text: 'Could not load this page.' }), (e && e.message) || 'Request failed', ' ', h('button', { class: 'btn small', text: 'Try again', onclick: route })))); });
  }
  // One sign-in from the admin back office: the embedding admin page may hand over its
  // Growth Engine session. Accepted only from the direct parent window, only from an
  // origin on this engine's embed list (from /health), and only if /admin/session
  // accepts the token; otherwise ignored.
  // The back office may also end the session ({type:'fmm-growth-logout'}): same checks, then the
  // session is revoked on the server and forgotten here.
  function fromAllowedParent(event) {
    return fetch(API + '/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (hl) {
      var allowed = (hl && hl.console && hl.console.embedOrigins) || [];
      return allowed.indexOf(event.origin) !== -1;
    });
  }
  if (EMBEDDED) window.addEventListener('message', function (event) {
    var d = event.data;
    if (event.source !== window.parent || !d || typeof d !== 'object') return;
    if (d.type === 'fmm-growth-logout') {
      fromAllowedParent(event).then(function (ok) { if (ok) signOut('You have signed out of administration.'); }).catch(function () { /* ignore */ });
      return;
    }
    if (d.type !== 'fmm-growth-session' || typeof d.token !== 'string' || d.token.length > 4096) return;
    if (d.token === token()) { tellParent(parse().name, { event: 'session-ready', expiresAt: state.sessionExpMs || null }); return; }
    fromAllowedParent(event).then(function (ok) {
      if (!ok) return;
      return fetch(API + '/admin/session', { cache: 'no-store', headers: { Authorization: 'Bearer ' + d.token } }).then(function (r) {
        if (!r.ok) { tellParent('signin', { event: 'session-expired', reason: 'session_rejected' }); return; }
        return r.json().then(function (s) {
          setToken(d.token); state.sessionExpMs = s && s.exp ? s.exp * 1000 : null; scheduleExpiry(state.sessionExpMs);
          if (!location.hash || location.hash === '#/signin') location.hash = '#/overview';
          tellParent(parse().name, { event: 'session-ready', expiresAt: state.sessionExpMs });
          boot();
        });
      });
    }).catch(function () { /* ignore */ });
  });

        /* BEGIN authorized 2026-11-06 original poster workflow. */
  pages.qa = function(main) {
    return Promise.all([api('GET','/admin/attribution'),api('GET','/admin/social')]).then(function(r){
      clear(main);add(main,[head('Administrator QA','Technical acceptance only; no live publishing or outreach is authorized.'),r[0].attribution.synthetic?syntheticCard(r[0].attribution.synthetic):h('p',{text:'No synthetic journey configuration in this environment.'}),liveTestCard(r[1])]);
    });
  };
  function posterDepartment(main, params) {
    return api('GET','/admin/drafts?kind=marketing&limit=100'+(params.fightId?'&contestId='+encodeURIComponent(params.fightId):'')).then(function(r){
      clear(main);main.appendChild(head('Posters','Original campaign artwork, verified QR destinations and downloads. Owner approval remains separate.'));
      var current=r.drafts.filter(function(d){return d.status!=='rejected'&&d.poster;});
      if(!current.length) main.appendChild(h('div',{class:'empty',text:'No current campaign posters. Verified eligible fights appear here when original artwork is ready.'}));
      current.forEach(function(d){main.appendChild(h('section',{class:'card',testid:'poster-campaign','data-draft-id':d.id},h('h2',{text:d.headline||d.id}),d.contest?fightFacts(d.contest):null,posterPanel(d,function(){posterDepartment(main,params);}),h('a',{class:'btn',href:'#/approvals?kind=marketing',text:'Review campaign approval'})));});
    });
  }
        /* END authorized 2026-11-06 original poster workflow. */
  function boot() {
    if (!token()) return renderLogin();
    api('GET', '/admin/session').then(function (s) { state.sessionExpMs = s && s.exp ? s.exp * 1000 : null; scheduleExpiry(state.sessionExpMs); route(); }).catch(function (e) { if (!e.silent) renderLogin(); });
  }
  window.addEventListener('hashchange', route);
  boot();
})();

/* BEGIN authorized 2026-11-06 embedded geometry protocol. */
(function () {
  'use strict';
  if (!document.documentElement.classList.contains('embedded') || !window.ResizeObserver) return;
  var last = 0, queued = false;
  window.addEventListener('message', function (event) {
    var origin = location.ancestorOrigins && location.ancestorOrigins[0];
    var height = event.data && event.data.height;
    if (!origin || event.source !== window.parent || event.origin !== origin || event.data.type !== 'fmm-growth-viewport' || !Number.isInteger(height) || height < 160 || height > 10000) return;
    document.documentElement.style.setProperty('--fmm-owner-viewport', height + 'px');
  });
  function measure() {
    queued = false;
    var layout = document.querySelector('.layout');
    var header = document.querySelector('.topbar');
    if (!layout) return;
    var height = Math.ceil(layout.scrollHeight + (header ? header.offsetHeight : 0) + 2);
    if (height < 160 || height > 30000 || height === last) return;
    last = height;
    var section = (location.hash.replace(/^#\//, '').split('?')[0] || 'overview');
    window.parent.postMessage({type:'fmm-growth-console',event:'content-size',section:section,height:height}, (location.ancestorOrigins && location.ancestorOrigins[0]) || '*');
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(measure); } }
  var observer = new ResizeObserver(schedule);
  observer.observe(document.body);
  new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('hashchange',schedule);
  window.addEventListener('load',schedule);
  schedule();
})();
/* END authorized 2026-11-06 embedded geometry protocol. */
