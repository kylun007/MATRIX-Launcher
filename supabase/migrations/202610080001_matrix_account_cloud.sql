-- MATRIX Account and Cloud metadata. Large archives stay in the user's Drive.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  avatar_url text check (avatar_url is null or (avatar_url like 'https://%' and char_length(avatar_url) <= 2048)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version > 0),
  preferences jsonb not null default '{}'::jsonb check (octet_length(preferences::text) <= 65536),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  resource_type text not null check (resource_type in ('skin-project', 'mod-collection', 'instance-manifest')),
  resource_id uuid not null,
  revision bigint not null default 1 check (revision > 0),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null check (octet_length(manifest::text) <= 262144),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(user_id, resource_type, resource_id)
);

create table if not exists public.user_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null check (char_length(device_name) between 1 and 80),
  platform text not null check (platform in ('win32', 'linux', 'darwin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(user_id, id)
);

create table if not exists public.cloud_backup_metadata (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.user_devices(id) on delete set null,
  resource_type text not null check (resource_type in ('world', 'skin-project', 'launcher-data')),
  drive_file_id text not null check (char_length(drive_file_id) between 1 and 512),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  created_at timestamptz not null default now()
);

create index if not exists sync_records_user_updated_idx on public.sync_records(user_id, updated_at desc);
create index if not exists cloud_backup_metadata_user_created_idx on public.cloud_backup_metadata(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.sync_records enable row level security;
alter table public.user_devices enable row level security;
alter table public.cloud_backup_metadata enable row level security;

create policy "profiles owner select" on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy "profiles owner insert" on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy "profiles owner update" on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "profiles owner delete" on public.profiles for delete to authenticated using (user_id = (select auth.uid()));

create policy "preferences owner all" on public.user_preferences for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "sync records owner all" on public.sync_records for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "devices owner all" on public.user_devices for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "backup metadata owner all" on public.cloud_backup_metadata for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.profiles, public.user_preferences, public.sync_records, public.user_devices, public.cloud_backup_metadata from anon;
grant select, insert, update, delete on public.profiles, public.user_preferences, public.sync_records, public.user_devices, public.cloud_backup_metadata to authenticated;
