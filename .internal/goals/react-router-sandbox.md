# React Router mounted sandbox preview

Status: Approved. Investigation and regression in progress.

The public sandbox mounts guest previews at `/__preview/5173/`. The proxy forwards
`/` to React Router, while its browser router sees the mounted pathname. This lane
owns the React Router template and its focused mounted-preview regression. The
shared preview transport and other framework templates remain separate work.
