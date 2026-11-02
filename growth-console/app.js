/* FANTASY MMADNESS Growth Engine back office (isolated staging).
 * Talks only to the same-origin /api/growth/admin API. Every value from the
 * API is inserted as text (never as HTML); email previews render in a
 * sandboxed iframe without scripts. */
(function () {
  'use strict';
  var API = '/api/growth';
  var TOKEN_KEY = 'fmmGrowthConsoleToken';
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
  function tellParent(section) { if (EMBEDDED) { try { var parentOrigin = (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) || '*'; window.parent.postMessage({ type: 'fmm-growth-console', section: section, signedIn: Boolean(token()) }, parentOrigin); } catch (e) { /* ignore */ } } }

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
    var map = {
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
  function token() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }
  function api(method, path, body) {
    var headers = { Accept: 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
          if (r.status === 401 && path !== '/admin/login') { setToken(''); renderLogin('Your session ended. Please sign in again.'); throw Object.assign(new Error('signed_out'), { silent: true }); }
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
      var first = back.querySelector('input,textarea,select'); (first || confirmBtn).focus();
    });
  }
  function emailPreview(html) {
    // No allow-scripts / allow-same-origin: the draft cannot run code or reach the console.
    return h('iframe', { class: 'preview', sandbox: '', title: 'Email preview', srcdoc: String(html || ''), testid: 'email-preview' });
  }
  function copyText(text) {
    var done = function () { toast('Copied to clipboard. Paste it into the social account.', 'good'); };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    fallbackCopy(text); done(); return Promise.resolve();
  }
  function fallbackCopy(text) { var t = h('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } t.remove(); }

  // ---------- login ----------
  function renderLogin(message) {
    var app = clear(document.getElementById('app')); tellParent('signin');
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
        h('span', { class: 'stage-pill', text: 'STAGING · nothing is sent' }),
        h('button', { class: 'signout', testid: 'signout', text: 'Sign out', onclick: function () { setToken(''); renderLogin('You have signed out.'); } })),
      h('div', { class: 'layout' }, nav, main),
    ]);
    main.appendChild(h('div', { class: 'spinner', text: 'Loading live staging data…' }));
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
      h('div', { class: 'draft-top' }, kindChip(d.kind), h('span', { class: 'chip', text: sport(d.genre) }), chip(d.status), d.editCount ? h('span', { class: 'chip info', text: 'Edited' }) : null, h('span', { class: 'when', text: 'Created ' + when(d.createdAt) })),
      h('h3', { testid: 'draft-title', text: isEmail ? (d.subject || '(no subject)') : (d.headline || '(no headline)') }),
      isEmail ? h('div', { class: 'meta' }, h('span', null, 'To: ', h('strong', { text: d.recipient || '—' })), d.relevanceSource ? h('a', { href: d.relevanceSource, target: '_blank', rel: 'noopener noreferrer', text: 'Why this contact' }) : null) : null,
      d.kind === 'marketing' && d.contest ? fightFacts(d.contest) : null,
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
    return card;
  }
  function fightFacts(c) {
    var when = c.dateKey + (c.timeTba || !c.matchTime ? ' (time TBA)' : ' ' + c.matchTime + (c.timeZone ? ' ' + c.timeZone : ''));
    return h('div', { class: 'facts', testid: 'fight-facts' },
      h('span', { class: 'chip good', text: '✓ Verified contest' }),
      h('span', null, h('strong', { text: c.fighterA + ' vs ' + c.fighterB })),
      h('span', { text: sport(c.sport) }), h('span', { text: when }),
      c.eventName ? h('span', { text: c.eventName }) : null, c.venue ? h('span', { text: [c.venue, c.city].filter(Boolean).join(', ') }) : null,
      h('a', { href: c.contestUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open contest' }));
  }
  function channelPosts(d) {
    var names = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', tiktok: 'TikTok' };
    var body = h('div', { class: 'body', testid: 'draft-text', text: d.posts.instagram || d.text || '' });
    var tabs = h('div', { class: 'channel-tabs', role: 'tablist' });
    Object.keys(names).forEach(function (ch, i) {
      if (!d.posts[ch]) return;
      tabs.appendChild(h('button', { type: 'button', class: 'btn small' + (i === 0 ? ' active' : ''), 'data-channel': ch, testid: 'channel-' + ch, text: names[ch], onclick: function (e) {
        tabs.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); }); e.target.classList.add('active'); body.textContent = d.posts[ch];
      } }));
    });
    return h('div', null, tabs, body);
  }
  function approve(d, reload) {
    var isEmail = d.kind !== 'marketing';
    return modal({
      title: 'Approve this ' + (KIND_NAMES[d.kind] || 'item').toLowerCase() + '?', confirmLabel: 'Approve', confirmClass: 'approve',
      body: h('p', { text: isEmail ? 'Approving queues this email. Real email delivery is OFF in staging, so it will NOT be sent until you switch delivery on.' : 'Approving marks this post ready to publish. Nothing is posted automatically: copy it into your social accounts, then mark it as published.' }),
      onConfirm: function () { return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/approve'); },
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
    var text = h('textarea', { maxlength: '4000', testid: 'edit-text' }); text.value = d.text || '';
    return modal({
      title: 'Edit before approving', confirmLabel: 'Save changes',
      body: h('div', null, h('label', { class: 'field' }, h('span', { text: isEmail ? 'Subject' : 'Headline' }), title),
        h('label', { class: 'field' }, h('span', { text: isEmail ? 'Email text' : 'Instagram / Facebook caption' }), text, h('small', { text: isEmail ? 'Saving rebuilds the email from this text.' : 'Keep both fighter names and the contest link. The safeguard checks your edit again.' }))),
      onConfirm: function () {
        var body = { text: text.value }; if (isEmail) body.subject = title.value; else body.headline = title.value;
        return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/edit', body);
      },
    }).then(function (ok) { if (ok) { toast('Changes saved. It is still waiting for your approval.', 'good'); reload(); } }).catch(fail);
  }
  function localInput(date) { var z = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); }
  function schedulePosts(d, reload) {
    return api('GET', '/admin/social').then(function (info) {
      var boxes = {}; var names = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', tiktok: 'TikTok' };
      var when = h('input', { type: 'datetime-local', testid: 'schedule-time' }); when.value = localInput(new Date(Date.now() + 10 * 60000));
      var rows = Object.keys(names).filter(function (ch) { return d.posts && d.posts[ch]; }).map(function (ch) {
        var c = info.channels[ch] || {}; var noImg = c.needsImage && !(d.contest && d.contest.posterUrl);
        var box = h('input', { type: 'checkbox', testid: 'schedule-' + ch }); box.checked = !noImg; box.disabled = noImg; boxes[ch] = box;
        return h('label', { class: 'check-row' }, box, ' ', h('strong', { text: names[ch] }), ' ',
          noImg ? h('span', { class: 'chip warn', text: 'Needs a fight poster image' }) : c.ready ? h('span', { class: 'chip ' + (c.mode === 'live' ? 'good' : 'info'), text: c.mode === 'live' ? '✓ Connected' : 'Sandbox (simulated)' }) : h('span', { class: 'chip warn', text: 'Not connected: will be held' }),
          c.note ? h('small', { class: 'muted', text: ' ' + c.note }) : null);
      });
      return modal({
        title: 'Schedule this fight campaign', confirmLabel: 'Schedule',
        body: h('div', null, h('p', { class: 'small', text: 'Each post is checked again against the live contest list right before it goes out. Channels that are not connected yet hold the post until you connect them and press Retry.' }),
          h('div', { class: 'field' }, h('span', { text: 'Channels' }), rows), h('label', { class: 'field' }, h('span', { text: 'Post time (your local time)' }), when)),
        onConfirm: function () {
          var chosen = Object.keys(boxes).filter(function (k) { return boxes[k].checked; });
          return api('POST', '/admin/drafts/' + encodeURIComponent(d.id) + '/schedule', { channels: chosen, scheduledAt: new Date(when.value).toISOString() });
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

  pages.overview = function (main) {
    return Promise.all([api('GET', '/admin/overview'), api('GET', '/admin/status'), api('GET', '/admin/alerts')]).then(function (r) {
      var o = r[0].overview, st = r[1], alerts = r[2].alerts, sc = st.scheduler;
      state.pendingCount = o.draftsAwaitingReview; state.alertCount = alerts.length;
      clear(main);
      var rep = o.latestReport;
      add(main, [
        head('Overview', 'Live results from the isolated Growth Engine (database: ' + st.database.name + ').',
          h('button', { class: 'btn', testid: 'btn-refresh', text: '↻ Refresh', onclick: function () { route(); } })),
        sc.healthy
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
    draftList(list, q, q.status === 'needs_owner_review' ? 'Nothing is waiting for your approval right now.' : 'No items match these filters.');
    return Promise.resolve();
  };

  pages.marketing = function (main, params) {
    var g = params.sport || '';
    return Promise.all([api('GET', '/admin/marketing/coverage'), api('GET', '/admin/drafts?kind=marketing&limit=300')]).then(function (r) {
      var cov = r[0].coverage, drafts = r[1].drafts, latest = cov.latest;
      clear(main);
      var counts = {}; drafts.forEach(function (d) { counts[d.status] = (counts[d.status] || 0) + 1; });
      var list = h('div', { testid: 'marketing-list' });
      var sel = sportSelect(g, function (v) { location.hash = '#/marketing' + (v ? '?sport=' + v : ''); }); sel.setAttribute('data-testid', 'filter-sport');
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
      draftList(list, { kind: 'marketing', limit: 300, _genre: g }, 'No fight campaigns yet.');
    });
  };

  function outreachPage(main, params, cfg) {
    var g = params.sport || SPORTS[0];
    return Promise.all([api('GET', '/admin/workstreams?department=' + cfg.department), api('GET', '/admin/prospects?limit=500'), api('GET', '/admin/drafts?kind=' + cfg.kind + '&limit=200')]).then(function (r) {
      var ws = r[0], partners = r[1].prospects, drafts = r[2].drafts;
      clear(main);
      var prepared = ws.workstreams.reduce(function (n, w) { return n + w.draftCount; }, 0);
      var awaiting = drafts.filter(function (d) { return d.status === 'needs_owner_review'; }).length;
      var tabs = h('div', { class: 'tabs', role: 'tablist', testid: 'sport-tabs' });
      SPORTS.forEach(function (s) {
        var w = ws.workstreams.filter(function (x) { return x.genre === s; })[0];
        tabs.appendChild(h('button', { role: 'tab', class: s === g ? 'active' : '', 'aria-selected': String(s === g), testid: 'tab-' + s, onclick: function () { location.hash = '#/' + cfg.route + '?sport=' + s; } },
          sport(s), h('span', { class: 'badge zero', text: w ? String(w.draftCount) : '0' })));
      });
      var detail = h('div', { testid: 'prepared-list' }, h('div', { class: 'spinner', text: 'Loading prepared outreach…' }));
      var list = h('div', { testid: cfg.kind + '-draft-list' });
      add(main, [
        head(cfg.title, cfg.subtitle),
        h('div', { class: 'grid tiles' },
          tile('Prepared this run', prepared, 'Template drafts across 5 sports', '#/' + cfg.route, cfg.kind + '-prepared'),
          tile('Media & creator prospects', partners.length, 'Podcasts, shows & creators found', '#/' + cfg.route, cfg.kind + '-prospects'),
          tile('Verified contacts', partners.filter(function (p) { return p.contactVerified; }).length, 'Added by you', '#/' + cfg.route, cfg.kind + '-contacts'),
          tile('Awaiting approval', awaiting, 'Personalized emails', '#/approvals?kind=' + cfg.kind, cfg.kind + '-awaiting')),
        h('div', { class: 'banner info' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: 'ℹ' }), h('div', null, h('strong', { text: 'How this works' }),
          'The engine finds prospects and prepares a draft for each one. Public discovery never finds a private email address, so a draft can only become a real email after you add a verified business contact and how they agreed to hear from you. That creates a personalized email in Campaign Approvals.')),
        h('section', { class: 'card' }, h('h2', { text: 'Prepared ' + cfg.noun + ' (latest run' + (ws.runId ? ' ' + ws.runId : '') + ')' }), tabs, detail),
        h('section', { class: 'card' }, h('h2', { text: 'Personalized ' + cfg.noun + ' emails' }), h('p', { class: 'sub', text: 'Created when you add a verified contact. Approve or reject them here or in Campaign Approvals.' }), list),
      ]);
      draftList(list, { kind: cfg.kind, limit: 200 }, 'None yet. Use “Add verified contact” on a prospect above to create one.');
      if (cfg.kind === 'affiliate') { var pipe = h('section', { class: 'card', testid: 'onboarding' }, h('h2', { text: 'Onboarding pipeline' }), h('div', { class: 'spinner', text: 'Loading…' })); main.insertBefore(pipe, main.children[3] || null); onboarding(pipe); }
      var w = ws.workstreams.filter(function (x) { return x.genre === g; })[0];
      if (!w) { clear(detail).appendChild(h('div', { class: 'empty', text: 'No ' + cfg.noun + ' workstream has run for ' + sport(g) + ' yet.' })); return; }
      return api('GET', '/admin/workstreams/' + encodeURIComponent(w.runId) + '/' + encodeURIComponent(w.workstreamId)).then(function (dr) {
        var rows = dr.workstream.drafts; clear(detail);
        if (!rows.length) { detail.appendChild(h('div', { class: 'empty', text: 'No prospects for ' + sport(g) + ' in this run.' })); return; }
        var byId = {}; partners.forEach(function (p) { byId[p.id] = p; });
        var tbody = h('tbody');
        rows.forEach(function (d) {
          var p = byId[d.prospectId] || {};
          var tr = h('tr', { testid: 'prepared-row', 'data-prospect-id': d.prospectId });
          var preview = h('tr', { class: 'preview-row' }); preview.hidden = true;
          var previewCell = h('td', { colspan: '4' }); preview.appendChild(previewCell);
          add(tr, [
            h('td', null, h('strong', { text: d.prospectName || p.name || d.prospectId }), h('div', { class: 'small' }, d.sourceUrl ? h('a', { href: d.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Public source' }) : null)),
            h('td', { class: 'small', text: d.subject || '—' }),
            h('td', null, p.contactVerified ? h('span', { class: 'chip good', text: '✓ ' + (p.contact || 'verified') }) : p.optedOut ? h('span', { class: 'chip bad', text: 'Opted out' }) : h('span', { class: 'chip', text: 'No contact yet' })),
            h('td', { class: 'nowrap' },
              h('button', { class: 'btn small', testid: 'btn-view-template', text: 'View draft', onclick: function (e) {
                if (!preview.hidden) { preview.hidden = true; clear(previewCell); e.target.textContent = 'View draft'; return; }
                previewCell.appendChild(emailPreview(d.html)); preview.hidden = false; e.target.textContent = 'Hide draft';
              } }), ' ',
              h('button', { class: 'btn primary small', testid: 'btn-add-contact', text: 'Add verified contact', onclick: function () { addContact(d.prospectId, d.prospectName || p.name, cfg.kind); } })),
          ]);
          tbody.appendChild(tr); tbody.appendChild(preview);
        });
        add(detail, [h('p', { class: 'muted small', testid: 'prepared-count', text: rows.length + ' prepared for ' + sport(g) }),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'Prospect' }), h('th', { text: 'Draft subject' }), h('th', { text: 'Contact' }), h('th', { text: '' }))), tbody))]);
      });
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
  pages.pr = function (main, params) {
    return outreachPage(main, params, { kind: 'pr', department: 'public-relations', route: 'pr', title: 'Public Relations', noun: 'media outreach', subtitle: 'Media coverage outreach to combat-sports podcasts and shows.' });
  };
  pages.affiliates = function (main, params) {
    return outreachPage(main, params, { kind: 'affiliate', department: 'affiliate-recruitment', route: 'affiliates', title: 'Affiliate Recruitment', noun: 'affiliate invitation', subtitle: 'Invitations for creators to run their own FANTASY MMADNESS fan leagues. Approved affiliates get tracked links (see Revenue Attribution).' });
  };

  pages.automation = function (main, params) {
    var alertState = params.alerts === 'all' ? 'all' : 'open';
    return Promise.all([api('GET', '/admin/status'), api('GET', '/admin/alerts?state=' + alertState), api('GET', '/admin/jobs?limit=40'), api('GET', '/admin/runs?limit=40'), api('GET', '/admin/suppressions?limit=100'), api('GET', '/admin/audit?limit=40')]).then(function (r) {
      var st = r[0], alerts = r[1].alerts, jobs = r[2].jobs, runs = r[3].runs, sup = r[4].suppressions, log = r[5].entries, sc = st.scheduler;
      if (alertState === 'open') state.alertCount = alerts.length;
      clear(main);
      var runNow = h('button', { class: 'btn primary', testid: 'btn-run-now', text: '▶ Run now', onclick: function () {
        modal({ title: 'Run the Growth Engine now?', confirmLabel: 'Run now', body: h('p', { text: 'This runs one cycle immediately, exactly like the automatic 15-minute run. The same safety rules apply: nothing is sent or posted.' }),
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
              return h('tr', { testid: 'alert-row', 'data-alert-key': a.alertKey }, h('td', null, h('strong', { text: a.kind + ': ' + a.id }), h('div', { class: 'small muted', text: a.error })), h('td', { class: 'nowrap small', text: when(a.createdAt) }), h('td', null, chip(a.state)),
                h('td', null, a.state === 'open' ? h('button', { class: 'btn small', testid: 'btn-ack', text: 'Acknowledge', onclick: function () {
                  api('POST', '/admin/alerts/' + encodeURIComponent(a.alertKey) + '/ack').then(function (res) { toast(res.ok ? 'Alert acknowledged.' : 'Already acknowledged.', 'good'); refreshCounts(); route(); }).catch(fail);
                } }) : h('span', { class: 'small muted', text: a.ackBy ? 'by ' + a.ackBy : '' })));
            })))) : h('div', { class: 'empty', testid: 'alerts-empty', text: alertState === 'open' ? 'No open alerts. Everything is running normally.' : 'No alerts recorded.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Background jobs' }), h('p', { class: 'sub', text: 'Daily discovery, follow-ups and the daily report. Failed jobs retry automatically up to 3 times; after that you can run them again.' }),
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
        head('Analytics', 'Computed live from the staging database · ' + when(a.generatedAt)),
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
      var rejected = Object.keys(a.rejectedEvents || {});
      add(main, [
        head('Revenue Attribution', 'Which campaigns and affiliates bring in paying players.'),
        h('div', { class: 'banner warn', testid: 'payment-banner' }, h('span', { class: 'ico', 'aria-hidden': 'true', text: '!' }), h('div', null, h('strong', { text: 'Live payments are not connected to staging.' }), a.paymentSource.note + ' Connecting real payment data needs your approval.')),
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

  pages.publishing = function (main) {
    return api('GET', '/admin/social').then(function (r) {
      clear(main);
      var names = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', tiktok: 'TikTok' };
      var paused = r.paused.paused;
      var toggle = h('button', { class: 'btn ' + (paused ? 'approve' : 'danger'), testid: 'btn-toggle-pause', text: paused ? '▶ Resume publishing' : '⏸ Pause all publishing', onclick: function () {
        modal({ title: paused ? 'Resume publishing?' : 'Pause all publishing?', confirmLabel: paused ? 'Resume' : 'Pause', confirmClass: paused ? 'approve' : 'danger',
          body: h('p', { text: paused ? 'Scheduled posts that are due will go out on the next run (every 15 minutes), after their fight is checked again.' : 'Nothing will be posted to any channel until you resume. Scheduled posts stay in the queue.' }),
          onConfirm: function () { return api('POST', '/admin/social/pause', { paused: !paused }); } }).then(function (ok) { if (ok) { toast(paused ? 'Publishing resumed.' : 'Publishing paused.', 'good'); route(); } }).catch(fail);
      } });
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
          h('td', null, h('strong', { text: names[p.channel] || p.channel }), p.sandbox ? h('div', null, h('span', { class: 'chip info', text: 'Sandbox (simulated)' })) : null),
          h('td', null, h('div', { class: 'small', text: (p.text || '').split('\n')[0] }), h('div', { class: 'small muted', text: sport(p.genre) })),
          h('td', { class: 'nowrap small', text: when(p.publishedAt || p.scheduledAt) }),
          h('td', null, chip(p.status), p.heldReason ? h('div', { class: 'small muted', text: p.heldReason }) : null, p.lastError ? h('div', { class: 'small muted', text: p.lastError }) : null, p.cancelReason ? h('div', { class: 'small muted', text: friendly(p.cancelReason) }) : null, p.pending ? h('div', { class: 'small muted', text: p.pending === 'in_tiktok_inbox_as_draft' ? 'In your TikTok inbox as a draft: finish posting in the app.' : 'Processing at TikTok.' }) : null, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', text: 'View post' }) : null),
          acts);
      });
      add(main, [
        head('Publishing', 'Scheduled social posts for approved fight campaigns. Nothing posts without your approval, and every fight is checked again just before posting.', toggle),
        paused ? h('div', { class: 'banner warn', testid: 'paused-banner' }, h('span', { class: 'ico', text: '⏸' }), h('div', null, h('strong', { text: 'Publishing is paused.' }), 'Nothing will be posted until you resume.' + (r.paused.by ? ' Paused by ' + r.paused.by + '.' : ''))) : null,
        h('section', { class: 'card' }, h('h2', { text: 'Channels' }), h('p', { class: 'sub', text: 'Mode: ' + (r.provider === 'none' ? 'off (posts are held)' : r.provider === 'sandbox' ? 'sandbox: posting is simulated, nothing reaches the real accounts' : 'live') }),
          h('div', { class: 'grid tiles' }, Object.keys(names).map(function (ch) { var c = r.channels[ch] || {}; return h('div', { class: 'tile', testid: 'channel-tile-' + ch }, h('div', { class: 'label', text: names[ch] }), h('div', { class: 'value text', text: c.mode === 'live' ? 'Connected' : c.mode === 'sandbox' ? 'Sandbox' : 'Off' }), h('div', { class: 'hint', text: c.ready ? (c.note || 'Ready') : 'See Connections for what is needed' })); }))),
        h('section', { class: 'card' }, h('h2', { text: 'Queue' }), rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data', testid: 'posts-table' }, h('thead', null, h('tr', null, h('th', { text: 'Channel' }), h('th', { text: 'Post' }), h('th', { text: 'When' }), h('th', { text: 'Status' }), h('th', { text: '' }))), h('tbody', null, rows)))
          : h('div', { class: 'empty', testid: 'posts-empty', text: 'Nothing scheduled. Approve a fight campaign, then press “Schedule posts”.' })),
      ]);
    });
  };

  pages.connections = function (main) {
    return Promise.all([api('GET', '/admin/connections'), api('GET', '/admin/email/readiness').catch(function () { return { readiness: null }; })]).then(function (r) {
      var c = r[0].connections, e = r[1].readiness; clear(main);
      var names = { facebook: 'Facebook Page', instagram: 'Instagram business account', x: 'X account', tiktok: 'TikTok account' };
      var list = function (items) { return h('ul', { class: 'checklist' }, items.map(function (it) { return h('li', { class: it.done ? 'done' : 'todo' }, h('span', { 'aria-hidden': 'true', text: it.done ? '✓ ' : '○ ' }), it.text); })); };
      add(main, [
        head('Connections', 'What the Growth Engine is connected to, and exactly what is still needed. Nothing here can send or post on its own.'),
        h('section', { class: 'card', testid: 'conn-social' }, h('h2', { text: 'Social media publishing' }), h('p', { class: 'sub', text: 'Mode: ' + c.social.provider + (c.social.paused.paused ? ' · paused' : '') }),
          Object.keys(names).map(function (ch) { var x = c.social.channels[ch]; return h('div', { class: 'conn-row' }, h('strong', { text: names[ch] }), ' ', x.mode === 'live' ? h('span', { class: 'chip good', text: '✓ Live' }) : x.mode === 'sandbox' ? h('span', { class: 'chip info', text: 'Sandbox' }) : h('span', { class: 'chip', text: 'Off' }), x.blockers.length ? list(x.blockers.map(function (b) { return { done: false, text: b }; })) : null, x.note ? h('p', { class: 'small muted', text: x.note }) : null); })),
        h('section', { class: 'card', testid: 'conn-email' }, h('h2', { text: 'Business email (PR and affiliate invitations)' }), h('p', { class: 'sub', text: 'Sender: ' + c.email.sender + ' · real sending: ' + (c.email.realDelivery ? 'ON' : 'OFF') }),
          e ? list(e.steps) : h('p', { class: 'muted', text: 'Could not run the email check right now.' }),
          e && e.dns.error ? h('p', { class: 'small muted', text: 'DNS lookup problem: ' + e.dns.error }) : null),
        h('section', { class: 'card', testid: 'conn-results' }, h('h2', { text: 'Registrations and paying players' }),
          list([
            { done: true, text: 'Every Growth Engine link carries the campaign tag the live site already records when someone registers' },
            { done: c.liveRegistrationReport.configured, text: 'Read-only live registration report connected' + (c.liveRegistrationReport.latest ? ' (last pulled ' + c.liveRegistrationReport.latest.day + ')' : '') },
            { done: c.verifiedEventIngest.configured, text: 'Signed event channel ready for verified registrations and settled paid entries (' + c.verifiedEventIngest.path + ')' },
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
    document.title = (NAV.filter(function (n) { return n[0] === r.name; })[0] || ['', 'Growth Engine'])[1] + ' · Growth Engine (staging)';
    Promise.resolve(pages[r.name](main, r.params)).then(function () { if (state.pendingCount === null) refreshCounts(); else paintBadges(); })
      .catch(function (e) { if (e && e.silent) return; clear(main).appendChild(h('div', { class: 'banner bad', testid: 'page-error' }, h('span', { class: 'ico', text: '!' }), h('div', null, h('strong', { text: 'Could not load this page.' }), (e && e.message) || 'Request failed', ' ', h('button', { class: 'btn small', text: 'Try again', onclick: route })))); });
  }
  // One sign-in from the admin back office: the embedding admin page may hand over its
  // Growth Engine session. Accepted only from the direct parent window, only from an
  // origin on this engine's embed list (from /health), and only if /admin/session
  // accepts the token; otherwise ignored.
  if (EMBEDDED) window.addEventListener('message', function (event) {
    var d = event.data;
    if (event.source !== window.parent || !d || d.type !== 'fmm-growth-session' || typeof d.token !== 'string' || d.token.length > 4096) return;
    if (d.token === token()) return;
    fetch(API + '/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (hl) {
      var allowed = (hl && hl.console && hl.console.embedOrigins) || [];
      if (allowed.indexOf(event.origin) === -1) return;
      return fetch(API + '/admin/session', { cache: 'no-store', headers: { Authorization: 'Bearer ' + d.token } }).then(function (r) {
        if (!r.ok) return;
        setToken(d.token); if (!location.hash || location.hash === '#/signin') location.hash = '#/overview'; boot();
      });
    }).catch(function () { /* ignore */ });
  });

  function boot() {
    if (!token()) return renderLogin();
    api('GET', '/admin/session').then(function () { route(); }).catch(function (e) { if (!e.silent) renderLogin(); });
  }
  window.addEventListener('hashchange', route);
  boot();
})();
