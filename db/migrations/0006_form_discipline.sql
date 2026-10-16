-- A form can be limited to one discipline, so an Ayurveda patient is not sent the physiotherapy questions
-- (and the other way round). Existing forms stay as they were: they apply to every appointment.
ALTER TABLE forms ADD COLUMN discipline TEXT NOT NULL DEFAULT 'any' CHECK (discipline IN ('any','physio','ayurveda'));
