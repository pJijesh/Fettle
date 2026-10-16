-- Check-ins from patients are sorted into "routine" and "needs a look". Plain rules decide first; the AI assistant,
-- only if the clinic has switched it on, can raise a check-in to "needs a look" but never lower one.
ALTER TABLE check_ins ADD COLUMN triage_level TEXT NOT NULL DEFAULT 'routine' CHECK (triage_level IN ('routine','review'));
ALTER TABLE check_ins ADD COLUMN triage_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE check_ins ADD COLUMN triage_source TEXT NOT NULL DEFAULT 'rules' CHECK (triage_source IN ('rules','assistant'));
ALTER TABLE check_ins ADD COLUMN reviewed_at TIMESTAMPTZ;
ALTER TABLE check_ins ADD COLUMN reviewed_by TEXT;
CREATE INDEX idx_checkins_open ON check_ins (clinic_id, created_at) WHERE triage_level = 'review' AND reviewed_at IS NULL;

ALTER TABLE clinics ADD COLUMN ai_triage INTEGER NOT NULL DEFAULT 0 CHECK (ai_triage IN (0, 1));
