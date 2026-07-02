# Phase: Admin Fighter Image Upload Backend Fix

## Problem
The admin fighter library only accepted a pasted image URL. Admin users needed to upload a fighter image directly instead of manually entering a Cloudinary URL.

## Backend update
The combat fighter create/update APIs now accept multipart form uploads.

Supported upload field names:

- `image`
- `fighterImage`
- `primaryImage`
- `primaryImageFile`

Updated routes:

- `POST /api/admin/combat-fighters`
- `PATCH /api/admin/combat-fighters/:id`

## Behavior
- Uploaded images are sent to Cloudinary under the `combat_fighters` folder.
- The backend saves `primaryImage` and `imagePublicId` on the fighter record.
- The fighter `imageHealth` is marked as valid/admin-uploaded.
- If a fighter was previously `needs_review`, uploading an image marks the fighter as `active` unless the request explicitly sends another status.
- For edit/update, the previous Cloudinary public ID is cleaned up when a new uploaded image replaces it.
- Existing URL-based updates still work, so old frontend behavior remains compatible.

## Frontend impact
A frontend update is still needed to replace the Image URL text-only input with a file picker and to fix the overflowing admin fighter UI.
