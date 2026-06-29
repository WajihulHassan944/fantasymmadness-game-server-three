# Phase 2 Draft Visibility and Fight Deletion Backend Update

- Public fight APIs now hide draft fights by default.
- Legacy `/match` now hides draft fights by default.
- Public fight detail and sitemap data now exclude draft fights.
- Admin/internal requests can still include drafts with `includeDrafts=true`.
- Match schema accepts Draft/Scheduled/Live/Open/Closed status values for admin workflows.
- Existing delete fight route remains available.
- No existing routes or functionality were removed.
