-- Contact enquiries can now carry an optional phone number (the embedded
-- contact widget asks Name / Email / Tel / Message; Tel is optional).
ALTER TABLE enquiries ADD COLUMN phone TEXT;
