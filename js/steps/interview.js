// interview.js — adaptive deep-dive interview.
// The LLM inspects the profile for thin spots, asks 2–3 questions per batch,
// decides after each batch whether to dig deeper or stop, and merges answers
// back into the profile (hidden_expertise + enriched experience entries).
// State is persisted so the user can leave and resume.

import { el, toast } from '../app.js';
import { chatJSON } from '../providers/index.js';
import { fillPrompt } from '../prompts.js';
import { getProfile, saveProfile, getSettings, ls, KEYS } from '../storage.js';

const MAX_ROUNDS = 8; // hard safety cap so the interview can never run forever

export async function renderInterview(root) {
  root.append(
    el('h1', {}, 'Adaptive interview'),
    el('p', { class: 'subtitle' },
      'Short batches of 2–3 questions about the places where your profile is thin. ',
      'It stops automatically once your profile is saturated. You can leave anytime — progress is saved.'),
  );

  const profile = getProfile();
  if (!profile) {
    root.append(el('div', { class: 'empty-state' },
      el('div', { class: 'big' }, '📄'),
      el('p', {}, 'No profile yet. ', el('a', { href: '#/onboarding' }, 'Upload your CV first'), '.')));
    return;
  }

  const settings = getSettings();
  if (!settings.provider || !settings.apiKeys?.[settings.provider]) {
    root.append(el('div', { class: 'notice warn' },
      'The interview needs your LLM key. ', el('a', { href: '#/settings' }, 'Add it in Settings'), '.'));
    return;
  }

  // --- UI skeleton ---
  const progressBar = el('div', { class: 'progress-bar', style: 'width:0%' });
  const progressLabel = el('span', { class: 'muted' }, '');
  const chatBox = el('div', { class: 'chat' });
  const inputArea = el('div', {});

  root.append(
    el('div', { class: 'card' },
      el('div', { style: 'display:flex; align-items:center; gap:12px;' },
        el('strong', {}, 'Profile completeness'),
        el('span', { class: 'spacer' }),
        progressLabel),
      el('div', { class: 'progress-wrap' }, progressBar),
      chatBox,
      inputArea,
    ),
  );

  // --- State ---
  let state = ls.get(KEYS.INTERVIEW_STATE, null) || {
    transcript: [], // [{q, a}]
    round: 0,
    completeness: ls.get(KEYS.PROFILE_META, {})?.completeness ?? 35,
    pendingQuestions: null,
  };

  function persist() {
    ls.set(KEYS.INTERVIEW_STATE, state);
    const meta = ls.get(KEYS.PROFILE_META, {});
    meta.completeness = state.completeness;
    ls.set(KEYS.PROFILE_META, meta);
  }

  function setProgress(pct) {
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    progressLabel.textContent = `~${pct}%`;
  }

  function addMsg(role, text) {
    chatBox.append(el('div', { class: `chat-msg ${role}` }, text));
    chatBox.lastChild.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // Replay transcript so resuming feels seamless.
  for (const { q, a } of state.transcript) {
    addMsg('bot', q);
    addMsg('user', a);
  }
  setProgress(state.completeness);

  // --- Engine ---

  async function nextBatch() {
    inputArea.innerHTML = '';
    inputArea.append(el('p', { class: 'muted' },
      el('span', { class: 'spinner' }), ' Analyzing your profile for thin spots…'));

    const transcriptText = state.transcript.length
      ? state.transcript.map(({ q, a }, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${a}`).join('\n\n')
      : '(empty — first turn)';

    let result;
    try {
      const prompt = await fillPrompt('interview', {
        PROFILE: getProfile(),
        TRANSCRIPT: transcriptText,
      });
      result = await chatJSON([{ role: 'user', content: prompt }], { temperature: 0.5 });
    } catch (err) {
      inputArea.innerHTML = '';
      inputArea.append(el('div', { class: 'notice warn' }, 'LLM call failed: ' + (err.message || err),
        el('div', { style: 'margin-top:8px;' },
          el('button', { class: 'btn btn-sm', onclick: nextBatch }, 'Retry'))));
      return;
    }

    state.completeness = Math.round(result.completeness ?? state.completeness);
    setProgress(state.completeness);

    const reachedCap = state.round >= MAX_ROUNDS;
    if (result.done || reachedCap || !result.questions?.length) {
      finish();
      return;
    }

    state.pendingQuestions = result.questions.slice(0, 3);
    persist();
    askPending();
  }

  function askPending() {
    const questions = state.pendingQuestions;
    const qText = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    addMsg('bot', qText);

    inputArea.innerHTML = '';
    const ta = el('textarea', { placeholder: 'Answer in free form — bullet points are fine. Answer what you can, skip what you can\'t.' });
    const sendBtn = el('button', { class: 'btn' }, 'Send answers');
    const stopBtn = el('button', { class: 'btn btn-secondary' }, 'Finish interview');

    sendBtn.addEventListener('click', async () => {
      const answer = ta.value.trim();
      if (!answer) return toast('Write at least something — or press "Finish interview".', 'error');
      sendBtn.disabled = true;
      stopBtn.disabled = true;
      sendBtn.innerHTML = '<span class="spinner"></span> Merging into profile…';

      addMsg('user', answer);
      state.transcript.push({ q: qText, a: answer });
      state.round += 1;
      state.pendingQuestions = null;

      // Merge answers into the profile.
      try {
        const mergePrompt = await fillPrompt('interview-merge', {
          PROFILE: getProfile(),
          QA: `Questions:\n${qText}\n\nAnswers:\n${answer}`,
        });
        const updated = await chatJSON([{ role: 'user', content: mergePrompt }], { temperature: 0.2 });
        if (updated && updated.basics) {
          saveProfile(updated);
        }
      } catch (err) {
        console.error('Merge failed, answers kept in transcript:', err);
        toast('Could not merge answers into profile this round (kept in transcript).', 'error', 6000);
      }

      persist();
      nextBatch();
    });

    stopBtn.addEventListener('click', finish);

    inputArea.append(el('div', { class: 'chat-input-row' }, ta),
      el('div', { style: 'display:flex; gap:10px; margin-top:10px;' }, sendBtn, stopBtn));
    ta.focus();
  }

  function finish() {
    const meta = ls.get(KEYS.PROFILE_META, {});
    meta.interviewDone = true;
    meta.completeness = Math.max(state.completeness, 60);
    ls.set(KEYS.PROFILE_META, meta);
    ls.remove(KEYS.INTERVIEW_STATE);

    setProgress(meta.completeness);
    inputArea.innerHTML = '';
    addMsg('bot', 'That\'s a wrap! Your master profile is now significantly richer than your CV. 🎉');
    inputArea.append(
      el('div', { style: 'display:flex; gap:10px; margin-top:14px;' },
        el('a', { href: '#/dashboard', class: 'btn' }, 'Open the job dashboard'),
        el('a', { href: '#/onboarding', class: 'btn btn-secondary' }, 'Review profile'),
      ),
    );
  }

  // --- Entry point: resume pending questions or start a new batch ---
  const startBtn = el('button', { class: 'btn' },
    state.transcript.length ? 'Continue interview' : 'Start interview');
  startBtn.addEventListener('click', () => {
    if (state.pendingQuestions?.length) askPending();
    else nextBatch();
  });
  inputArea.append(startBtn);
}
