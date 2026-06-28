
import 'dotenv/config';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CloudantV1 } from '@ibm-cloud/cloudant';
import { IamAuthenticator } from 'ibm-cloud-sdk-core';
 
const app = express();
app.use(express.json());
 
// Explicit IAM auth — avoids the "ContainerAuthenticator" error
// that happens when no auth env vars are detected automatically
const cloudant = new CloudantV1({
  authenticator: new IamAuthenticator({
    apikey: process.env.CLOUDANT_APIKEY,
  }),
  serviceUrl: process.env.CLOUDANT_URL,
});
 
const DB = process.env.CLOUDANT_DB_TASKS || 'tasks';
 
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (process.env.WRAPPER_API_TOKEN && token !== process.env.WRAPPER_API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.use(requireAuth);
 
app.post('/tasks', async (req, res) => {
  try {
    const { title, owner = null, deadline = null, status = 'open', note = '' } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
 
    const now = new Date().toISOString();
    const doc = {
      _id: `task:${uuidv4().slice(0, 8)}`,
      type: 'task',
      title,
      owner,
      deadline,
      status,
      history: [{ at: now, action: 'created', by: 'agent', note: note || 'Created by Co-Pilot agent' }],
      conflict: { is_conflict: false },
      last_nudge_sent_at: null,
      nudge_count: 0,
      created_at: now,
      updated_at: now,
    };
    const result = await cloudant.postDocument({ db: DB, document: doc });
    res.status(201).json({ ...doc, _rev: result.result.rev });
  } catch (err) {
    console.error('POST /tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.put('/tasks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { owner, deadline, status, note } = req.body;
 
    const existing = await cloudant.getDocument({ db: DB, docId: taskId }).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'task not found' });
 
    const doc = existing.result;
    if (owner !== undefined) doc.owner = owner;
    if (deadline !== undefined) doc.deadline = deadline;
    if (status !== undefined) doc.status = status;
    doc.history = doc.history || [];
    doc.history.push({ at: new Date().toISOString(), action: 'updated', by: 'agent', note: note || 'Updated by Co-Pilot agent' });
    doc.updated_at = new Date().toISOString();
 
    const result = await cloudant.postDocument({ db: DB, document: doc });
    res.json({ ...doc, _rev: result.result.rev });
  } catch (err) {
    console.error('PUT /tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/tasks/flag_conflict', async (req, res) => {
  try {
    const { title, owner = null, deadline = null, conflicting_task_id = null, reason } = req.body;
    if (!title || !reason) return res.status(400).json({ error: 'title and reason are required' });
 
    const now = new Date().toISOString();
    const doc = {
      _id: `task:${uuidv4().slice(0, 8)}`,
      type: 'task',
      title,
      owner,
      deadline,
      status: 'conflict',
      history: [{ at: now, action: 'flagged_conflict', by: 'agent', note: reason }],
      conflict: { is_conflict: true, conflicting_task_id, reason },
      last_nudge_sent_at: null,
      nudge_count: 0,
      created_at: now,
      updated_at: now,
    };
    const result = await cloudant.postDocument({ db: DB, document: doc });
    res.status(201).json({ ...doc, _rev: result.result.rev });
  } catch (err) {
    console.error('POST /tasks/flag_conflict error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/tasks/:taskId/nudge', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { reminder_text } = req.body;
    if (!reminder_text) return res.status(400).json({ error: 'reminder_text is required' });
 
    const existing = await cloudant.getDocument({ db: DB, docId: taskId }).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'task not found' });
 
    const doc = existing.result;
    const now = new Date().toISOString();
    doc.history = doc.history || [];
    doc.history.push({ at: now, action: 'nudge_sent', by: 'agent', note: reminder_text });
    doc.last_nudge_sent_at = now;
    doc.nudge_count = (doc.nudge_count || 0) + 1;
    doc.updated_at = now;
 
    const result = await cloudant.postDocument({ db: DB, document: doc });
    res.json({ ...doc, _rev: result.result.rev });
  } catch (err) {
    console.error('POST /tasks/nudge error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// List open tasks — for Orchestrate tool use
app.post('/tasks/_find', async (req, res) => {
  try {
    const { selector, limit } = req.body;
    const result = await cloudant.postFind({ db: DB, selector: selector || { type: 'task' }, limit: limit || 100 });
    res.json({ docs: result.result.docs });
  } catch (err) {
    console.error('POST /tasks/_find error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/health', (req, res) => res.json({ status: 'ok', db: DB, url: process.env.CLOUDANT_URL }));
 
const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`[task-wrapper] listening on :${PORT}`));
