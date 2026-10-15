-- Ayurveda as a second discipline. A clinic practises physiotherapy, Ayurveda or both. Each appointment type and
-- each consultation belongs to one discipline; everything else (diary, patients, billing, patient link) is shared.
ALTER TABLE clinics ADD COLUMN disciplines TEXT NOT NULL DEFAULT 'physio' CHECK (disciplines IN ('physio','ayurveda','both'));
ALTER TABLE appointment_types ADD COLUMN discipline TEXT NOT NULL DEFAULT 'physio' CHECK (discipline IN ('physio','ayurveda'));
ALTER TABLE consults ADD COLUMN discipline TEXT NOT NULL DEFAULT 'physio' CHECK (discipline IN ('physio','ayurveda'));
