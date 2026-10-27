'use strict';

// One-time, owner-approved repair (2026-10-27).
// The Fight Launch Desk used to pre-select the first fight in its list, so the
// owner's Elif Nur Turhan vs Alycia Baumgardner poster (made for Kelise Davis)
// was saved as the poster of the Pro Wrestling WWE fight below.
//
// This removes ONLY that misplaced poster reference from that ONE fight, and
// only while it is still exactly that image. It never deletes the image file,
// never touches the fight's own artwork (promotionBackground) or any other
// field, and keeps a record of what it removed so it can be restored.
const FIX_KEY = 'remove-misplaced-poster-wwe-6ac6de084b103d29472b831f';
const FIGHT_ID = '6ac6de084b103d29472b831f';
const WRONG_POSTER_URL = 'https://res.cloudinary.com/dq2fwh1ui/image/upload/v1793113448/fight_social_posters/u1sezpxwo9o23buiczbz.png';
const WRONG_POSTER_ID = 'fight_social_posters/u1sezpxwo9o23buiczbz';

async function runPosterCleanup({ mongoose, clearCache }) {
  const db = mongoose.connection.db;
  const records = db.collection('maintenancerecords');
  if (await records.findOne({ key: FIX_KEY, done: true })) return { skipped: 'already done' };
  const id = new mongoose.Types.ObjectId(FIGHT_ID);
  const models = ['ProWrestlingMatch', 'Match', 'Shadow'].map((name) => mongoose.models[name]).filter(Boolean);
  for (const Model of models) {
    const doc = await Model.collection.findOne({ _id: id }, { projection: { fightPosterImage: 1, fightPosterImageDeleteUrl: 1 } });
    if (!doc) continue;
    if (doc.fightPosterImage !== WRONG_POSTER_URL) {
      await records.updateOne({ key: FIX_KEY }, { $set: { key: FIX_KEY, done: true, at: new Date(), result: 'nothing to remove', currentPoster: doc.fightPosterImage || '' } }, { upsert: true });
      return { result: 'nothing to remove' };
    }
    const unset = { fightPosterImage: '' };
    // The stored delete id would make a later upload on this fight delete the
    // image file; drop it too, but only when it is that same image.
    if (doc.fightPosterImageDeleteUrl === WRONG_POSTER_ID) unset.fightPosterImageDeleteUrl = '';
    // Plain collection update: no other field (not even updatedAt) changes.
    const result = await Model.collection.updateOne({ _id: id, fightPosterImage: WRONG_POSTER_URL }, { $unset: unset });
    await records.updateOne({ key: FIX_KEY }, { $set: {
      key: FIX_KEY, done: true, at: new Date(), collection: Model.collection.collectionName, fightId: FIGHT_ID,
      removed: { fightPosterImage: doc.fightPosterImage, fightPosterImageDeleteUrl: doc.fightPosterImageDeleteUrl || '' },
      modified: result.modifiedCount, imageFileKept: true,
    } }, { upsert: true });
    if (typeof clearCache === 'function') clearCache();
    console.log(`[poster-cleanup] Removed misplaced poster reference from fight ${FIGHT_ID} (${Model.collection.collectionName}); image file kept.`);
    return { result: 'removed', modified: result.modifiedCount };
  }
  return { result: 'fight not found' };
}

function schedulePosterCleanup({ mongoose, clearCache }) {
  const go = () => runPosterCleanup({ mongoose, clearCache }).catch((error) => console.error('[poster-cleanup] failed:', error?.message || error));
  if (mongoose.connection.readyState === 1) go();
  else mongoose.connection.once('open', go);
}

module.exports = { runPosterCleanup, schedulePosterCleanup, FIX_KEY, FIGHT_ID, WRONG_POSTER_URL, WRONG_POSTER_ID };
