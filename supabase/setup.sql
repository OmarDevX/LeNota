-- Run once in Supabase Dashboard -> SQL Editor. Run again safely if needed.
-- No service-role secret is used by the app. All calls are made as the signed-in user.
BEGIN;
CREATE TABLE IF NOT EXISTS public.lenota_workspaces (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0 CHECK(version >= 0),
  snapshot jsonb NOT NULL DEFAULT '{"notebooks":{},"section_groups":{},"sections":{},"pages":{},"tags":{},"page_tags":{},"page_revisions":{},"trash_entries":{},"attachments":{}}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lenota_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lenota_workspaces FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.lenota_workspaces TO authenticated;
DROP POLICY IF EXISTS "lenota read own workspace" ON public.lenota_workspaces;
DROP POLICY IF EXISTS "lenota insert own workspace" ON public.lenota_workspaces;
DROP POLICY IF EXISTS "lenota update own workspace" ON public.lenota_workspaces;
CREATE POLICY "lenota read own workspace" ON public.lenota_workspaces FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "lenota insert own workspace" ON public.lenota_workspaces FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "lenota update own workspace" ON public.lenota_workspaces FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.lenota_pull(p_known_version bigint DEFAULT -1)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE w public.lenota_workspaces%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to sync' USING ERRCODE = '28000'; END IF;
  INSERT INTO public.lenota_workspaces(user_id) VALUES(auth.uid()) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT w FROM public.lenota_workspaces WHERE user_id = auth.uid();
  RETURN jsonb_build_object('version', w.version, 'snapshot', CASE WHEN w.version = p_known_version THEN NULL ELSE w.snapshot END);
END;
$$;

-- Compare-and-swap: a concurrent device push never overwrites another unseen push.
-- The client reloads the newer version, merges, and retries on committed=false.
CREATE OR REPLACE FUNCTION public.lenota_push(p_expected_version bigint, p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE w public.lenota_workspaces%ROWTYPE; t text; a record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to sync' USING ERRCODE = '28000'; END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN RAISE EXCEPTION 'Invalid expected version'; END IF;
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' OR octet_length(p_snapshot::text) > 33554432 THEN
    RAISE EXCEPTION 'Invalid or oversized workspace';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_snapshot)) <> 9 THEN RAISE EXCEPTION 'Incompatible sync schema'; END IF;
  FOREACH t IN ARRAY ARRAY['notebooks','section_groups','sections','pages','tags','page_tags','page_revisions','trash_entries','attachments'] LOOP
    IF jsonb_typeof(p_snapshot->t) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid record collection'; END IF;
  END LOOP;
  -- Metadata is committed only after each private file has been uploaded.
  FOR a IN SELECT key, value FROM jsonb_each(p_snapshot->'attachments') LOOP
    IF (a.value->>'stored_path') IS NULL OR (a.value->>'stored_path') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
      OR a.key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
      OR (a.value->>'size_bytes')::bigint NOT BETWEEN 0 AND 50000000 THEN
      RAISE EXCEPTION 'Invalid attachment metadata';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'lenota-notes'
        AND o.name = auth.uid()::text || '/' || a.key || '/' || (a.value->>'stored_path')
        AND (o.metadata->>'size')::bigint = (a.value->>'size_bytes')::bigint) THEN
      RAISE EXCEPTION 'An attachment has not finished uploading';
    END IF;
  END LOOP;
  INSERT INTO public.lenota_workspaces(user_id) VALUES(auth.uid()) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT w FROM public.lenota_workspaces WHERE user_id = auth.uid() FOR UPDATE;
  IF w.version <> p_expected_version THEN RETURN jsonb_build_object('committed',false,'version',w.version); END IF;
  IF w.snapshot IS DISTINCT FROM p_snapshot THEN
    UPDATE public.lenota_workspaces SET snapshot=p_snapshot,version=version+1,updated_at=now()
      WHERE user_id=auth.uid() RETURNING * INTO w;
  END IF;
  RETURN jsonb_build_object('committed',true,'version',w.version);
END;
$$;
REVOKE ALL ON FUNCTION public.lenota_pull(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lenota_push(bigint,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lenota_pull(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lenota_push(bigint,jsonb) TO authenticated;

INSERT INTO storage.buckets(id,name,public,file_size_limit)
VALUES('lenota-notes','lenota-notes',false,50000000)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=50000000;
DROP POLICY IF EXISTS "lenota read own files" ON storage.objects;
DROP POLICY IF EXISTS "lenota upload own files" ON storage.objects;
CREATE POLICY "lenota read own files" ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='lenota-notes' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
CREATE POLICY "lenota upload own files" ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='lenota-notes' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
-- No UPDATE/DELETE policy: managed files are immutable and retained for history.
COMMIT;
