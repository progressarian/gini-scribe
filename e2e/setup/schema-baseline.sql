
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE SCHEMA IF NOT EXISTS public;

COMMENT ON SCHEMA public IS 'standard public schema';

CREATE TYPE public.when_to_take_pill AS ENUM (
    'Fasting',
    'Before breakfast',
    'After breakfast',
    'Before lunch',
    'After lunch',
    'Before dinner',
    'After dinner',
    'At bedtime',
    'With milk',
    'SOS only',
    'Any time'
);

CREATE FUNCTION public.add_care_circle(p_patient_id integer, p_role text, p_name text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_organization text DEFAULT NULL::text, p_speciality text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_is_primary boolean DEFAULT false, p_data_sharing boolean DEFAULT false, p_next_appt date DEFAULT NULL::date, p_appt_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE new_id UUID;
BEGIN
  INSERT INTO care_circle(patient_id,role,name,phone,email,organization,speciality,notes,is_primary,data_sharing_enabled,next_appointment,next_appointment_notes)
  VALUES(p_patient_id,p_role,p_name,p_phone,p_email,p_organization,p_speciality,p_notes,p_is_primary,p_data_sharing,p_next_appt,p_appt_notes)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE FUNCTION public.alt_phone_text(p text[]) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT array_to_string(p, E'\n')
$$;

CREATE FUNCTION public.cast_when_to_take_token(tok text) RETURNS public.when_to_take_pill
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  BEGIN
    RETURN btrim(tok)::when_to_take_pill;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END$$;

CREATE FUNCTION public.delete_care_circle(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  DELETE FROM care_circle WHERE id = p_id;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.care_circle (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer,
    role text NOT NULL,
    name text NOT NULL,
    phone text,
    email text,
    organization text,
    speciality text,
    notes text,
    is_primary boolean DEFAULT false,
    gini_id text,
    data_sharing_enabled boolean DEFAULT false,
    next_appointment date,
    next_appointment_notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.care_circle FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.get_care_circle(p_patient_id integer) RETURNS SETOF public.care_circle
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY SELECT * FROM care_circle WHERE patient_id = p_patient_id ORDER BY is_primary DESC;
END;
$$;

CREATE FUNCTION public.gini_cancel_dose_change_request(p_request_id uuid, p_patient_id integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE medication_dose_change_requests
     SET status = 'cancelled',
         decided_at = now()
   WHERE id = p_request_id
     AND patient_id = p_patient_id
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

CREATE FUNCTION public.gini_create_dose_change_request(p_patient_id integer, p_medication_id text, p_medication_name text, p_current_dose text, p_requested_dose text DEFAULT NULL::text, p_dose_unit text DEFAULT NULL::text, p_patient_reason text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_id UUID;
  v_exists BOOLEAN;
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  IF p_medication_id IS NULL OR length(trim(p_medication_id)) = 0 THEN
    RAISE EXCEPTION 'p_medication_id is required';
  END IF;
  IF (p_patient_reason IS NULL OR length(trim(p_patient_reason)) = 0)
     AND (p_requested_dose IS NULL OR length(trim(p_requested_dose)) = 0) THEN
    RAISE EXCEPTION 'either a note or a requested dose is required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM patients WHERE id = p_patient_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'patient % not found', p_patient_id;
  END IF;

  INSERT INTO medication_dose_change_requests
    (patient_id, medication_id, medication_name, current_dose,
     requested_dose, dose_unit, patient_reason, initiated_by)
  VALUES
    (p_patient_id, p_medication_id, COALESCE(p_medication_name, ''),
     COALESCE(p_current_dose, ''),
     NULLIF(trim(COALESCE(p_requested_dose, '')), ''),
     p_dose_unit, p_patient_reason, 'patient')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE FUNCTION public.gini_create_refill_request(p_patient_id integer, p_items jsonb, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_request_id UUID;
  v_item JSONB;
  v_exists BOOLEAN;
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM patients WHERE id = p_patient_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'patient % not found', p_patient_id;
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items must be a non-empty JSON array';
  END IF;

  INSERT INTO medication_refill_requests (patient_id, notes)
  VALUES (p_patient_id, p_notes)
  RETURNING id INTO v_request_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO medication_refill_request_items
      (request_id, medication_name, dose, timing, quantity, source_medication_id)
    VALUES (
      v_request_id,
      COALESCE(v_item->>'medication_name', ''),
      v_item->>'dose',
      v_item->>'timing',
      GREATEST(1, COALESCE((v_item->>'quantity')::INT, 1)),
      v_item->>'source_medication_id'
    );
  END LOOP;

  RETURN v_request_id;
END;
$$;

CREATE FUNCTION public.gini_delete_patient_side_effect(p_id uuid, p_patient_id integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM patient_reported_side_effects
   WHERE id = p_id AND patient_id = p_patient_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

CREATE FUNCTION public.gini_get_patient_dose_change_requests(p_patient_id integer, p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, patient_id integer, medication_id text, medication_name text, current_dose text, requested_dose text, final_dose text, dose_unit text, patient_reason text, status text, doctor_id text, doctor_note text, reject_reason text, initiated_by text, requested_at timestamp with time zone, decided_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  RETURN QUERY
    SELECT r.id, r.patient_id, r.medication_id, r.medication_name,
           r.current_dose, r.requested_dose, r.final_dose, r.dose_unit,
           r.patient_reason, r.status, r.doctor_id, r.doctor_note,
           r.reject_reason, r.initiated_by, r.requested_at, r.decided_at
      FROM medication_dose_change_requests r
     WHERE r.patient_id = p_patient_id
     ORDER BY r.requested_at DESC
     LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.gini_get_patient_refill_requests(p_patient_id integer, p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, patient_id integer, status text, notes text, reject_reason text, requested_at timestamp with time zone, status_updated_at timestamp with time zone, status_updated_by text, items jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$                                                
  BEGIN
    IF p_patient_id IS NULL THEN
      RAISE EXCEPTION 'p_patient_id is required';                                                                                                         
    END IF;
    RETURN QUERY                                                                                                                                          
    SELECT                                               
      r.id, r.patient_id, r.status, r.notes, r.reject_reason,
      r.requested_at, r.status_updated_at, r.status_updated_by,                                                                                           
      COALESCE(
        (SELECT jsonb_agg(                                                                                                                                
          jsonb_build_object(                                                                                                                             
            'id', i.id,
            'medication_name', i.medication_name,                                                                                                         
            'dose', i.dose,                              
            'timing', i.timing,
            'quantity', i.quantity,
            'source_medication_id', i.source_medication_id                                                                                                
          ) ORDER BY i.medication_name
         ) FROM medication_refill_request_items i WHERE i.request_id = r.id),                                                                             
        '[]'::jsonb                                                                                                                                       
      ) AS items
    FROM medication_refill_requests r                                                                                                                     
    WHERE r.patient_id = p_patient_id                    
    ORDER BY r.requested_at DESC
    LIMIT p_limit;                                                                                                                                        
  END;
  $$;

CREATE FUNCTION public.gini_get_patient_side_effects(p_patient_id integer, p_medication_id text DEFAULT NULL::text, p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, patient_id integer, medication_id text, medication_name text, name text, description text, severity text, status text, source text, patient_note text, reported_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  RETURN QUERY
    SELECT r.id, r.patient_id, r.medication_id, r.medication_name,
           r.name, r.description, r.severity, r.status, r.source,
           r.patient_note, r.reported_at, r.updated_at
      FROM patient_reported_side_effects r
     WHERE r.patient_id = p_patient_id
       AND (p_medication_id IS NULL OR r.medication_id = p_medication_id)
     ORDER BY r.reported_at DESC
     LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.gini_sync_appointment(p_gini_patient_id text, p_source_id text, p_appointment_date date, p_doctor_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_status text DEFAULT 'scheduled'::text, p_appointment_time text DEFAULT NULL::text, p_purpose text DEFAULT NULL::text, p_pre_visit_symptoms text[] DEFAULT NULL::text[], p_pre_visit_notes text DEFAULT NULL::text, p_pre_visit_symptoms_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_pre_visit_compliance jsonb DEFAULT NULL::jsonb, p_pre_visit_compliance_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_patient_id UUID;
BEGIN
  SELECT id INTO v_patient_id FROM patients WHERE gini_patient_id = p_gini_patient_id;
  IF v_patient_id IS NULL THEN RETURN; END IF;

  IF EXISTS (SELECT 1 FROM appointments WHERE patient_id = v_patient_id AND source_id = p_source_id) THEN
    UPDATE appointments SET
      appointment_date = p_appointment_date, doctor_name = p_doctor_name,
      notes = p_notes, status = p_status,
      appointment_time = COALESCE(p_appointment_time, appointment_time),
      purpose = COALESCE(p_purpose, purpose),
      pre_visit_symptoms     = COALESCE(p_pre_visit_symptoms, pre_visit_symptoms),
      pre_visit_notes        = COALESCE(p_pre_visit_notes, pre_visit_notes),
      pre_visit_symptoms_at  = COALESCE(p_pre_visit_symptoms_at, pre_visit_symptoms_at),
      pre_visit_compliance    = COALESCE(p_pre_visit_compliance, pre_visit_compliance),
      pre_visit_compliance_at = COALESCE(p_pre_visit_compliance_at, pre_visit_compliance_at),
      source = 'scribe'
    WHERE patient_id = v_patient_id AND source_id = p_source_id;
  ELSE
    INSERT INTO appointments (patient_id, appointment_date, doctor_name, notes, status,
                              appointment_time, purpose, source, source_id,
                              pre_visit_symptoms, pre_visit_notes, pre_visit_symptoms_at,
                              pre_visit_compliance, pre_visit_compliance_at)
    VALUES (v_patient_id, p_appointment_date, p_doctor_name, p_notes, p_status,
            p_appointment_time, p_purpose, 'scribe', p_source_id,
            p_pre_visit_symptoms, p_pre_visit_notes, p_pre_visit_symptoms_at,
            p_pre_visit_compliance, p_pre_visit_compliance_at);
  END IF;
END;
$$;

CREATE FUNCTION public.gini_sync_vitals(p_gini_patient_id text, p_source_id text, p_recorded_at timestamp with time zone, p_bp_sys numeric, p_bp_dia numeric, p_pulse numeric, p_spo2 numeric, p_weight numeric, p_height numeric, p_temp numeric, p_source text) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin

insert into vitals (
  patient_id,
  source_id,
  recorded_at,
  bp_sys,
  bp_dia,
  pulse,
  spo2,
  weight,
  height,
  temperature,
  source,
  created_at
)
values (
  p_gini_patient_id,
  p_source_id,
  p_recorded_at,
  p_bp_sys,
  p_bp_dia,
  p_pulse,
  p_spo2,
  p_weight,
  p_height,
  p_temp,
  p_source,
  now()
);

end;
$$;

CREATE FUNCTION public.gini_upsert_patient_side_effect(p_id uuid, p_patient_id integer, p_medication_id text, p_medication_name text, p_name text, p_description text DEFAULT NULL::text, p_severity text DEFAULT 'common'::text, p_status text DEFAULT 'active'::text, p_source text DEFAULT 'custom'::text, p_patient_note text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_id UUID;
  v_exists BOOLEAN;
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM patients WHERE id = p_patient_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'patient % not found', p_patient_id;
  END IF;

  IF p_id IS NULL THEN
    -- Insert with ON CONFLICT on the (patient, med, lower(name)) unique
    -- index so re-tapping the same effect re-activates it instead of erroring.
    INSERT INTO patient_reported_side_effects
      (patient_id, medication_id, medication_name, name, description,
       severity, status, source, patient_note)
    VALUES
      (p_patient_id, p_medication_id, COALESCE(p_medication_name, ''),
       trim(p_name), p_description,
       COALESCE(p_severity, 'common'),
       COALESCE(p_status, 'active'),
       COALESCE(p_source, 'custom'),
       p_patient_note)
    ON CONFLICT (patient_id, COALESCE(medication_id, ''), lower(name))
    DO UPDATE SET
      description = EXCLUDED.description,
      severity = EXCLUDED.severity,
      status = EXCLUDED.status,
      patient_note = EXCLUDED.patient_note,
      updated_at = now()
    RETURNING id INTO v_id;
  ELSE
    UPDATE patient_reported_side_effects
       SET name = trim(p_name),
           description = p_description,
           severity = COALESCE(p_severity, severity),
           status = COALESCE(p_status, status),
           patient_note = p_patient_note,
           medication_id = p_medication_id,
           medication_name = COALESCE(p_medication_name, medication_name),
           updated_at = now()
     WHERE id = p_id
       AND patient_id = p_patient_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'side-effect row % not found for patient %', p_id, p_patient_id;
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

CREATE FUNCTION public.notify_appt_inserted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify(
    'appt_inserted',
    json_build_object(
      'appt_id',      NEW.id,
      'patient_id',   NEW.patient_id,
      'source',       COALESCE(NEW.source, ''),
      'healthray_id', NEW.healthray_id
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.patient_messages_update_conversation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$                                                                                                                                                    
  BEGIN                                                  
    IF NEW.conversation_id IS NULL THEN RETURN NEW; END IF;                                                                                                                
    UPDATE conversations                                                                                                                                                   
       SET last_message_at = NEW.created_at,
           last_message_preview = LEFT(COALESCE(NEW.message, '[attachment]'), 120),                                                                                        
           last_sender = CASE WHEN NEW.direction = 'outbound' THEN 'patient' ELSE 'team' END,                                                                              
           team_unread_count = CASE
             WHEN NEW.direction = 'outbound' THEN team_unread_count + 1                                                                                                    
             ELSE team_unread_count END,                 
           patient_unread_count = CASE                                                                                                                                     
             WHEN NEW.direction = 'inbound' THEN patient_unread_count + 1                                                                                                  
             ELSE patient_unread_count END
     WHERE id = NEW.conversation_id;                                                                                                                                       
    RETURN NEW;                                                                                                                                                            
  END;
  $$;

CREATE FUNCTION public.resolve_doctor_id(p_name text) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT id FROM doctors
   WHERE is_active
     AND (lower(name) = lower(p_name) OR lower(short_name) = lower(p_name))
   ORDER BY (lower(name) = lower(p_name)) DESC
   LIMIT 1
$$;

CREATE FUNCTION public.update_care_circle(p_id uuid, p_role text, p_name text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_organization text DEFAULT NULL::text, p_speciality text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_is_primary boolean DEFAULT false, p_data_sharing boolean DEFAULT false, p_next_appt date DEFAULT NULL::date, p_appt_notes text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE care_circle SET role=p_role,name=p_name,phone=p_phone,email=p_email,organization=p_organization,
    speciality=p_speciality,notes=p_notes,is_primary=p_is_primary,data_sharing_enabled=p_data_sharing,
    next_appointment=p_next_appt,next_appointment_notes=p_appt_notes,updated_at=now()
  WHERE id=p_id;
END;
$$;

CREATE FUNCTION public.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE public.patients (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    phone character varying(20),
    dob date,
    age integer,
    sex text,
    file_no character varying(50),
    abha_id character varying(50),
    health_id character varying(50),
    aadhaar character varying(20),
    govt_id character varying(50),
    govt_id_type text,
    email character varying(100),
    address text,
    blood_group text,
    emergency_contact character varying(200),
    emergency_phone character varying(20),
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    gini_patient_id text,
    data_sharing_consent boolean DEFAULT false,
    password_hash text,
    otp_code text,
    otp_expires_at timestamp with time zone,
    otp_attempts smallint DEFAULT 0,
    otp_last_sent_at timestamp with time zone,
    verification_token text,
    verification_token_expires_at timestamp with time zone,
    force_password_reset boolean DEFAULT false NOT NULL,
    alt_phone text[],
    is_blocked boolean DEFAULT false NOT NULL,
    blocked_reason_code text,
    blocked_note text,
    blocked_at timestamp with time zone,
    blocked_by text,
    blocked_by_id integer,
    allergy_status text,
    allergy_note text,
    allergy_asked_at timestamp with time zone,
    allergy_asked_by integer,
    scheme_code text,
    scheme_ref text,
    CONSTRAINT patients_allergy_status_check CHECK ((allergy_status = ANY (ARRAY['not_known'::text, 'none_known'::text, 'known'::text]))),
    CONSTRAINT patients_sex_check CHECK ((sex = ANY (ARRAY[('Male'::character varying)::text, ('Female'::character varying)::text, ('Other'::character varying)::text])))
);

ALTER TABLE ONLY public.patients FORCE ROW LEVEL SECURITY;

CREATE TABLE public.active_visits (
    id integer NOT NULL,
    doctor_id integer,
    doctor_name text NOT NULL,
    patient_id integer,
    appointment_id integer,
    visit_type text DEFAULT 'new'::text,
    route text,
    started_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'scheduled'::text,
    step_data jsonb DEFAULT '{}'::jsonb
);

ALTER TABLE ONLY public.active_visits FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.active_visits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.active_visits_id_seq OWNED BY public.active_visits.id;

CREATE TABLE public.agent_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    checkpoint_summary text,
    summary_covers_n integer DEFAULT 0 NOT NULL,
    total_turns integer DEFAULT 0 NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.agent_conversations FORCE ROW LEVEL SECURITY;

CREATE TABLE public.ai_batch_jobs (
    id bigint NOT NULL,
    job_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    batch_id text,
    request jsonb NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone,
    completed_at timestamp with time zone
);

ALTER TABLE ONLY public.ai_batch_jobs FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.ai_batch_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_batch_jobs_id_seq OWNED BY public.ai_batch_jobs.id;

CREATE TABLE public.alert_channel (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id text,
    direction text DEFAULT 'scribe_to_genie'::text,
    alert_type text DEFAULT 'doctor_reply'::text,
    title text,
    message text,
    status text DEFAULT 'unread'::text,
    sender_name text,
    sender_role text DEFAULT 'doctor'::text,
    source_id text,
    synced_to_mhg timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    read_at timestamp with time zone
);

ALTER TABLE ONLY public.alert_channel FORCE ROW LEVEL SECURITY;

CREATE TABLE public.analytics_snapshot_sections (
    snapshot_id bigint NOT NULL,
    section_id text NOT NULL,
    payload jsonb NOT NULL
);

ALTER TABLE ONLY public.analytics_snapshot_sections FORCE ROW LEVEL SECURITY;

CREATE TABLE public.analytics_snapshots (
    id bigint NOT NULL,
    as_of date NOT NULL,
    engine_version text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    build_ms integer,
    status text DEFAULT 'ok'::text NOT NULL,
    error text
);

ALTER TABLE ONLY public.analytics_snapshots FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.analytics_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.analytics_snapshots_id_seq OWNED BY public.analytics_snapshots.id;

CREATE TABLE public.app_install_tracking (
    id integer NOT NULL,
    patient_id integer,
    file_no text,
    patient_name text,
    app_installed boolean DEFAULT false,
    profile_created boolean DEFAULT false,
    install_date date,
    registered_by_cc text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.app_install_tracking FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.app_install_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.app_install_tracking_id_seq OWNED BY public.app_install_tracking.id;

CREATE TABLE public.app_kv (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.app_kv FORCE ROW LEVEL SECURITY;

CREATE TABLE public.appointment_cancellations (
    id integer NOT NULL,
    original_appointment_id integer,
    cancel_type text,
    reason text,
    appointment_date date,
    appointment_time text,
    file_no text,
    patient_name text,
    mobile text,
    address text,
    doctor_name text,
    condition text,
    booking_date date,
    appointment_type text,
    visit_type text,
    visit_number integer,
    booked_by text,
    comments text,
    outcome text,
    requested_by_cc text,
    cc_remark_date date,
    rescheduled_to_date date,
    rescheduled_to_time text,
    whatsapp_message text,
    week_num integer,
    month_num integer,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.appointment_cancellations FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.appointment_cancellations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.appointment_cancellations_id_seq OWNED BY public.appointment_cancellations.id;

CREATE TABLE public.appointment_change_log (
    id integer NOT NULL,
    appointment_id integer NOT NULL,
    field text NOT NULL,
    field_label text,
    old_value text,
    new_value text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by text,
    changed_by_id integer
);

ALTER TABLE ONLY public.appointment_change_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.appointment_change_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.appointment_change_log_id_seq OWNED BY public.appointment_change_log.id;

CREATE TABLE public.appointment_reassignments (
    id integer NOT NULL,
    appointment_id integer,
    patient_id integer,
    file_no text,
    appointment_date date,
    time_slot text,
    from_doctor_name text,
    from_doctor_id integer,
    to_doctor_name text,
    to_doctor_id integer,
    trigger text,
    unavailability_id integer,
    reason text,
    reassigned_by text,
    patient_notified boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.appointment_reassignments FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.appointment_reassignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.appointment_reassignments_id_seq OWNED BY public.appointment_reassignments.id;

CREATE TABLE public.appointment_slots (
    id integer NOT NULL,
    doctor_name text NOT NULL,
    slot_date date NOT NULL,
    time_slot text NOT NULL,
    slot_type text DEFAULT 'regular'::text,
    total_capacity integer DEFAULT 5,
    booked_count integer DEFAULT 0,
    is_blocked boolean DEFAULT false,
    block_reason text
);

ALTER TABLE ONLY public.appointment_slots FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.appointment_slots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.appointment_slots_id_seq OWNED BY public.appointment_slots.id;

CREATE TABLE public.appointments (
    id integer NOT NULL,
    patient_id integer,
    patient_name character varying(200),
    file_no character varying(50),
    phone character varying(20),
    doctor_name character varying(200),
    appointment_date date DEFAULT CURRENT_DATE,
    time_slot character varying(20),
    visit_type character varying(50) DEFAULT 'OPD'::character varying,
    status character varying(30) DEFAULT 'scheduled'::character varying,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    prep_steps jsonb DEFAULT '{"assigned": false, "biomarkers": false, "compliance": false, "categorized": false}'::jsonb,
    biomarkers jsonb DEFAULT '{}'::jsonb,
    compliance jsonb DEFAULT '{}'::jsonb,
    category text,
    coordinator_notes jsonb DEFAULT '[]'::jsonb,
    opd_vitals jsonb DEFAULT '{}'::jsonb,
    is_walkin boolean DEFAULT false,
    age integer,
    sex text,
    visit_count integer DEFAULT 1,
    last_visit_date date,
    consultation_id integer,
    opd_medications jsonb DEFAULT '[]'::jsonb,
    opd_diagnoses jsonb DEFAULT '[]'::jsonb,
    opd_stopped_medications jsonb DEFAULT '[]'::jsonb,
    healthray_id bigint,
    healthray_clinical_notes text,
    healthray_diagnoses jsonb DEFAULT '[]'::jsonb,
    healthray_medications jsonb DEFAULT '[]'::jsonb,
    healthray_labs jsonb DEFAULT '[]'::jsonb,
    healthray_advice text,
    checked_in_at timestamp with time zone,
    source text,
    sheet_condition text,
    healthray_investigations jsonb DEFAULT '[]'::jsonb,
    healthray_follow_up jsonb,
    ai_summary jsonb,
    ai_summary_generated_at timestamp with time zone,
    healthray_previous_medications jsonb DEFAULT '[]'::jsonb,
    post_visit_summary jsonb,
    post_visit_summary_generated_at timestamp with time zone,
    pre_visit_symptoms text[],
    pre_visit_notes text,
    pre_visit_symptoms_at timestamp with time zone,
    pre_visit_compliance jsonb,
    pre_visit_compliance_at timestamp with time zone,
    follow_up_with text,
    opd_backfilled_at timestamp with time zone,
    reporting_time_slot text,
    appointment_type text DEFAULT 'Physical'::text,
    booking_date date,
    booking_source text DEFAULT 'OBT'::text,
    booked_by_name text,
    insurance_taken text,
    how_did_you_know text,
    referred_by_doctor_name text,
    earlier_slot_given boolean DEFAULT false,
    show_no_show text,
    reason_no_online text,
    requested_by_cc text,
    cc_remark_date date,
    whatsapp_message text,
    additional_whatsapp_msg text,
    will_get_test_at_gini boolean,
    chief_complaint text,
    condition text,
    misc_notes text,
    reports_uploaded boolean DEFAULT false,
    call_status text DEFAULT 'pending'::text,
    call_made_by text,
    call_date date,
    call_notes text,
    call_reschedule_date date,
    follow_up_date date,
    follow_up_time text,
    pt_recovery text,
    preferred_date date,
    preferred_doctor text,
    assigned_mo text,
    prescription_explained_by text,
    doctor_id integer,
    bill_paid text,
    bill_created boolean,
    healthray_patient_id text,
    family_member_id text,
    preferred_time_slot text,
    home_collection boolean DEFAULT false,
    calling_by text,
    calling_by_id integer,
    calling_since timestamp with time zone,
    patient_category text,
    corporate_company_id integer,
    corporate_package_id integer,
    corporate_email text,
    alt_phone text[],
    booking_status text
);

ALTER TABLE ONLY public.appointments FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.appointments.follow_up_with IS 'Doctor-authored free-text patient prep instructions for THIS appointment. Sourced from consultations.con_data.follow_up_with on the most recent prior consultation. Shown on Genie Care → Appts card and printed on the previous visit''s prescription PDF.';

COMMENT ON COLUMN public.appointments.how_did_you_know IS 'DORMANT — do not build on this. Free-text marketing-channel answer from the GHM Excel import; never populated (0 of 45,940 rows as of 2026-10-02) and no frontend writes it. Canonical inbound attribution is crm.patient_referral_sources, which distinguishes "came on my own" from "was never asked". See docs/CRM_PLAN.md.';

COMMENT ON COLUMN public.appointments.referred_by_doctor_name IS 'DORMANT — do not build on this. Free-text referring-doctor name from the GHM Excel import; never populated and cannot reference a doctor record. Canonical inbound attribution is crm.patient_referral_sources, whose doctor_id is a real foreign key to crm.doctors. See docs/CRM_PLAN.md.';

CREATE SEQUENCE public.appointments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.appointments_id_seq OWNED BY public.appointments.id;

CREATE TABLE public.audit_log (
    id integer NOT NULL,
    doctor_id integer,
    action character varying(50),
    entity_type character varying(50),
    entity_id integer,
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;

CREATE TABLE public.auth_sessions (
    id integer NOT NULL,
    doctor_id integer,
    token character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval),
    kind text DEFAULT 'doctor'::text NOT NULL,
    patient_id integer,
    patient_db text,
    patient_ref text
);

ALTER TABLE ONLY public.auth_sessions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.auth_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.auth_sessions_id_seq OWNED BY public.auth_sessions.id;

CREATE TABLE public.call_attempts (
    id integer NOT NULL,
    appointment_id integer NOT NULL,
    patient_id integer,
    attempt_no integer DEFAULT 1 NOT NULL,
    outcome text,
    called_by text,
    called_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_mins numeric,
    notes text,
    reschedule_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.call_attempts FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.call_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.call_attempts_id_seq OWNED BY public.call_attempts.id;

CREATE TABLE public.call_claim_sessions (
    id integer NOT NULL,
    appointment_id integer NOT NULL,
    patient_id integer,
    called_by text,
    called_by_id integer,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_secs integer,
    ended_reason text DEFAULT 'released'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.call_claim_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.call_claim_sessions_id_seq OWNED BY public.call_claim_sessions.id;

CREATE TABLE public.cc_agents (
    id integer NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.cc_agents FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.cc_agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cc_agents_id_seq OWNED BY public.cc_agents.id;

CREATE TABLE public.cc_calling_log (
    id integer NOT NULL,
    call_type text DEFAULT 'pre_visit'::text NOT NULL,
    patient_id integer,
    file_no text,
    patient_name text,
    dob text,
    mobile text,
    condition text,
    visit_date date,
    visit_type text,
    cc_assigned text,
    outcome_data text,
    pt_recovery text,
    follow_visit_date date,
    follow_up_appt_time text,
    fundus_status text,
    additional_followup_date date,
    gap_days integer,
    call_made_by text,
    calling_date date,
    call_duration_mins real,
    call_done boolean DEFAULT false,
    improvement_status text,
    appt_booked_on date,
    appt_time_slot text,
    appt_type text,
    appt_not_booked_reason text,
    medical_issues_noted boolean DEFAULT false,
    ticket_no text,
    followup_tests_status text,
    notes text,
    is_on_insulin boolean,
    show_no_show text,
    week_num integer,
    month_num integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.cc_calling_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.cc_calling_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cc_calling_log_id_seq OWNED BY public.cc_calling_log.id;

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    patient_id integer NOT NULL,
    role text NOT NULL,
    content text,
    image_uri text,
    actions jsonb,
    chat_date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.chat_messages FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;

CREATE TABLE public.clinic_holidays (
    id integer NOT NULL,
    holiday_date date NOT NULL,
    remarks text,
    entry_date date DEFAULT CURRENT_DATE,
    created_by text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.clinic_holidays FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.clinic_holidays_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.clinic_holidays_id_seq OWNED BY public.clinic_holidays.id;

CREATE TABLE public.clinical_reasoning (
    id integer NOT NULL,
    consultation_id integer,
    patient_id integer,
    doctor_id integer,
    doctor_name text,
    reasoning_text text,
    audio_url text,
    audio_duration integer,
    audio_transcript text,
    transcription_status text DEFAULT 'none'::text,
    primary_condition text,
    secondary_conditions text[],
    reasoning_tags text[],
    capture_method text DEFAULT 'text'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.clinical_reasoning FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.clinical_reasoning_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.clinical_reasoning_id_seq OWNED BY public.clinical_reasoning.id;

CREATE TABLE public.complications (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    name text,
    status text,
    detail text,
    severity text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    complication text,
    grade text,
    details text
);

ALTER TABLE ONLY public.complications FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.complications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.complications_id_seq OWNED BY public.complications.id;

CREATE TABLE public.consultation_test_status (
    consultation_id bigint NOT NULL,
    patient_id bigint NOT NULL,
    test_name text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.consultation_test_status FORCE ROW LEVEL SECURITY;

CREATE TABLE public.consultations (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    visit_date date DEFAULT CURRENT_DATE,
    visit_type text DEFAULT 'OPD'::character varying,
    mo_name text,
    con_name text,
    mo_transcript text,
    con_transcript text,
    quick_transcript text,
    mo_data jsonb,
    con_data jsonb,
    plan_edits jsonb,
    status text DEFAULT 'completed'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    mo_doctor_id integer,
    con_doctor_id integer,
    parsed_at timestamp with time zone,
    parse_version text,
    parse_error text,
    exam_data jsonb
);

ALTER TABLE ONLY public.consultations FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.consultations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.consultations_id_seq OWNED BY public.consultations.id;

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id text NOT NULL,
    kind text NOT NULL,
    doctor_id text,
    doctor_name text,
    last_message_at timestamp with time zone,
    last_message_preview text,
    last_sender text,
    team_unread_count integer DEFAULT 0 NOT NULL,
    patient_unread_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversations_kind_check CHECK ((kind = ANY (ARRAY['doctor'::text, 'lab'::text, 'reception'::text])))
);

ALTER TABLE ONLY public.conversations FORCE ROW LEVEL SECURITY;

CREATE TABLE public.corporate_companies (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    contact_email text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT corporate_companies_slug_format CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'::text))
);

ALTER TABLE ONLY public.corporate_companies FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.corporate_companies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.corporate_companies_id_seq OWNED BY public.corporate_companies.id;

CREATE TABLE public.corporate_package_tests (
    id integer NOT NULL,
    package_id integer NOT NULL,
    test_name text NOT NULL,
    precaution_note text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.corporate_package_tests FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.corporate_package_tests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.corporate_package_tests_id_seq OWNED BY public.corporate_package_tests.id;

CREATE TABLE public.corporate_packages (
    id integer NOT NULL,
    company_id integer NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.corporate_packages FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.corporate_packages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.corporate_packages_id_seq OWNED BY public.corporate_packages.id;

CREATE TABLE public.diabetes_champions (
    id integer NOT NULL,
    creation_date date,
    file_no text,
    patient_id integer,
    patient_name text NOT NULL,
    mobile text,
    email text,
    outcome text,
    tagged_on_fb boolean DEFAULT false,
    comments text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.diabetes_champions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.diabetes_champions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.diabetes_champions_id_seq OWNED BY public.diabetes_champions.id;

CREATE TABLE public.diagnoses (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    diagnosis_id text,
    label text,
    status text DEFAULT 'New'::character varying,
    since_year integer,
    notes text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    category text,
    complication_type text,
    external_doctor text,
    key_value text,
    trend text,
    sort_order integer DEFAULT 0
);

ALTER TABLE ONLY public.diagnoses FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.diagnoses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.diagnoses_id_seq OWNED BY public.diagnoses.id;

CREATE TABLE public.diet_plans (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    calories integer,
    protein_grams integer,
    exercise text,
    other_instructions text[],
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.diet_plans FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.diet_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.diet_plans_id_seq OWNED BY public.diet_plans.id;

CREATE TABLE public.doctor_profile (
    doctor_id integer NOT NULL,
    off_weekdays smallint[] DEFAULT '{0}'::smallint[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    work_start time without time zone,
    work_end time without time zone,
    lunch_start time without time zone,
    lunch_end time without time zone
);

ALTER TABLE ONLY public.doctor_profile FORCE ROW LEVEL SECURITY;

CREATE TABLE public.doctor_summaries (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    appointment_id integer,
    version integer NOT NULL,
    content text NOT NULL,
    change_note text,
    prev_version_id integer,
    author_name text,
    author_id text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.doctor_summaries FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.doctor_summaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.doctor_summaries_id_seq OWNED BY public.doctor_summaries.id;

CREATE TABLE public.doctor_unavailability (
    id integer NOT NULL,
    doctor_id integer NOT NULL,
    doctor_name text,
    type text DEFAULT 'leave'::text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    slot_labels text[],
    reason text,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text,
    reassignment_done boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT doctor_unavailability_check CHECK ((end_date >= start_date)),
    CONSTRAINT doctor_unavailability_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text]))),
    CONSTRAINT doctor_unavailability_type_check CHECK ((type = ANY (ARRAY['leave'::text, 'emergency'::text, 'holiday'::text, 'break'::text])))
);

ALTER TABLE ONLY public.doctor_unavailability FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.doctor_unavailability_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.doctor_unavailability_id_seq OWNED BY public.doctor_unavailability.id;

CREATE TABLE public.doctors (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    short_name character varying(100),
    specialty character varying(100),
    role character varying(30) DEFAULT 'mo'::character varying,
    pin character varying(255),
    phone character varying(20),
    license_no character varying(50),
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    healthray_id integer,
    is_chief boolean DEFAULT false,
    qualification text
);

ALTER TABLE ONLY public.doctors FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.doctors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.doctors_id_seq OWNED BY public.doctors.id;

CREATE TABLE public.documents (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    doc_type character varying(50),
    title character varying(200),
    file_name character varying(200),
    file_url text,
    storage_path text,
    mime_type character varying(50),
    extracted_text text,
    extracted_data jsonb,
    doc_date date,
    source character varying(30),
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    reviewed boolean DEFAULT false,
    uploaded_by_patient boolean DEFAULT false NOT NULL,
    giniflow_lab_order_id uuid
);

ALTER TABLE ONLY public.documents FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.documents.giniflow_lab_order_id IS 'The giniflow_lab_orders row this report was promoted from. UNIQUE: re-uploading replaces, never duplicates.';

CREATE SEQUENCE public.documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.documents_id_seq OWNED BY public.documents.id;

CREATE TABLE public.drug_master (
    id integer NOT NULL,
    generic_name text NOT NULL,
    brand_names text[] DEFAULT '{}'::text[],
    drug_class text,
    sub_class text,
    category text,
    common_doses text[] DEFAULT '{}'::text[],
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.drug_master FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.drug_master_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.drug_master_id_seq OWNED BY public.drug_master.id;

CREATE TABLE public.flow_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid,
    event_type text NOT NULL,
    step_order integer,
    details jsonb,
    triggered_by text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.flow_events FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_staff (
    id integer NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.flow_staff FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.flow_staff_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.flow_staff_id_seq OWNED BY public.flow_staff.id;

CREATE TABLE public.flow_step_catalog (
    id text NOT NULL,
    name text NOT NULL,
    default_duration_min integer NOT NULL,
    station text NOT NULL,
    assigned_role text NOT NULL,
    display_order integer,
    is_active boolean DEFAULT true,
    is_background boolean DEFAULT false NOT NULL,
    parent_step_catalog_id text,
    attach_when_any text[],
    chain_status text,
    machine boolean DEFAULT false NOT NULL,
    machine_order integer,
    machine_short_name text,
    machine_full_name text,
    machine_icon text,
    order_test_name text,
    bill_names text[] DEFAULT '{}'::text[] NOT NULL,
    value_fields text[] DEFAULT '{}'::text[] NOT NULL,
    report_doc_types text[] DEFAULT '{}'::text[] NOT NULL,
    hands_over boolean DEFAULT false NOT NULL,
    machine_station text DEFAULT 'machine_room'::text NOT NULL,
    machine_requires_before text,
    CONSTRAINT flow_step_catalog_machine_station_check CHECK ((machine_station = ANY (ARRAY['machine_room'::text, 'echo'::text, 'xray'::text])))
);

ALTER TABLE ONLY public.flow_step_catalog FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_step_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_type_id text NOT NULL,
    step_catalog_id text NOT NULL,
    step_order integer NOT NULL,
    is_default boolean DEFAULT true,
    is_optional boolean DEFAULT false,
    condition_key text,
    override_duration_min integer
);

ALTER TABLE ONLY public.flow_step_templates FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_visit_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    step_catalog_id text,
    step_order integer NOT NULL,
    step_name text NOT NULL,
    planned_duration_min integer NOT NULL,
    actual_duration_min integer,
    station text NOT NULL,
    assigned_role text NOT NULL,
    assigned_staff_id text,
    assigned_staff_name text,
    status text DEFAULT 'pending'::text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    data jsonb DEFAULT '{}'::jsonb,
    notes text,
    is_background boolean DEFAULT false NOT NULL,
    CONSTRAINT flow_visit_steps_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text])))
);

ALTER TABLE ONLY public.flow_visit_steps FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_visit_types (
    id text NOT NULL,
    label text NOT NULL,
    max_time_min integer NOT NULL,
    color text,
    is_flexible boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    for_followup boolean,
    for_walkin boolean,
    for_tests boolean,
    is_active boolean DEFAULT true NOT NULL,
    for_online boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.flow_visit_types FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id text NOT NULL,
    patient_db_id integer,
    appointment_id integer,
    patient_name text NOT NULL,
    patient_phone text,
    patient_age_sex text,
    visit_type_id text NOT NULL,
    visit_date date DEFAULT CURRENT_DATE,
    appointment_time text,
    has_tests_available boolean DEFAULT false,
    patient_status text,
    checkin_time timestamp with time zone DEFAULT now() NOT NULL,
    max_time_min integer NOT NULL,
    suggested_wait_min integer,
    estimated_completion timestamp with time zone,
    actual_completion timestamp with time zone,
    current_step_id uuid,
    current_step_order integer DEFAULT 0,
    status text DEFAULT 'in_progress'::text,
    is_vip boolean DEFAULT false,
    notes text,
    visit_token text,
    whatsapp_sent boolean DEFAULT false,
    checked_in_by text,
    assigned_sd integer,
    assigned_sd_name text,
    assigned_chief integer,
    assigned_chief_name text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    timer_started_at timestamp with time zone,
    paused_at timestamp with time zone,
    token_number text,
    CONSTRAINT flow_visits_patient_status_check CHECK ((patient_status = ANY (ARRAY['improving'::text, 'same'::text, 'worse'::text, 'new_patient'::text]))),
    CONSTRAINT flow_visits_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'cancelled'::text, 'waiting'::text, 'paused'::text])))
);

ALTER TABLE ONLY public.flow_visits FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_wait_daily (
    date date NOT NULL,
    visit_type_id text NOT NULL,
    visits_n integer DEFAULT 0 NOT NULL,
    completed_n integer DEFAULT 0 NOT NULL,
    booked_n integer,
    coverage_pct integer,
    median_total_min numeric(6,1),
    median_door_to_doctor_min numeric(6,1),
    breach_n integer DEFAULT 0 NOT NULL,
    on_time_pct integer,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    steps_completed_n integer,
    steps_with_start_n integer
);

ALTER TABLE ONLY public.flow_wait_daily FORCE ROW LEVEL SECURITY;

CREATE TABLE public.flow_wait_station_daily (
    date date NOT NULL,
    station text NOT NULL,
    assigned_role text,
    steps_n integer DEFAULT 0 NOT NULL,
    median_wait_min numeric(6,1),
    median_service_min numeric(6,1),
    median_planned_min numeric(6,1),
    exceeded_n integer DEFAULT 0 NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.flow_wait_station_daily FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_care_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    treatment text,
    lifestyle text,
    internal_note text,
    next_visit_date date,
    next_visit_interval text,
    goals jsonb DEFAULT '[]'::jsonb NOT NULL,
    source text DEFAULT 'typed'::text NOT NULL,
    authored_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.giniflow_care_plans FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_floor_settings (
    key text NOT NULL,
    value boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);

CREATE TABLE public.giniflow_interaction_acks (
    id bigint NOT NULL,
    visit_id uuid NOT NULL,
    rule_key text NOT NULL,
    severity text NOT NULL,
    medicines text[] DEFAULT '{}'::text[] NOT NULL,
    reason text NOT NULL,
    acked_by integer,
    acked_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.giniflow_interaction_acks FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.giniflow_interaction_acks IS 'A severe interaction prescribed deliberately, with the reason and who gave it. One row per visit per rule.';

CREATE SEQUENCE public.giniflow_interaction_acks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_interaction_acks_id_seq OWNED BY public.giniflow_interaction_acks.id;

CREATE TABLE public.giniflow_interaction_rules (
    id integer NOT NULL,
    class_a text NOT NULL,
    class_b text NOT NULL,
    severity text NOT NULL,
    note text NOT NULL,
    source text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT giniflow_interaction_rules_check CHECK ((class_a <= class_b)),
    CONSTRAINT giniflow_interaction_rules_severity_check CHECK ((severity = ANY (ARRAY['severe'::text, 'moderate'::text])))
);

ALTER TABLE ONLY public.giniflow_interaction_rules FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.giniflow_interaction_rules IS 'Class-pair interaction rules read by services/giniflow/interactions.js. class_a = class_b is a duplication rule. Clinical content: editable without a deploy.';

CREATE SEQUENCE public.giniflow_interaction_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_interaction_rules_id_seq OWNED BY public.giniflow_interaction_rules.id;

CREATE TABLE public.giniflow_lab_case_actions (
    id bigint NOT NULL,
    case_no text NOT NULL,
    action text NOT NULL,
    actor_role text DEFAULT 'lab'::text NOT NULL,
    actor_id integer,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT giniflow_lab_case_actions_action_check CHECK ((action = ANY (ARRAY['chased'::text, 'drawing_started'::text, 'sample_taken'::text, 'sample_sent'::text, 'sample_received'::text, 'processing'::text, 'results_ready'::text, 'report_uploaded'::text])))
);

ALTER TABLE ONLY public.giniflow_lab_case_actions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.giniflow_lab_case_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_lab_case_actions_id_seq OWNED BY public.giniflow_lab_case_actions.id;

CREATE TABLE public.giniflow_lab_order_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lab_order_id uuid NOT NULL,
    track text NOT NULL,
    status text NOT NULL,
    actor_role text DEFAULT 'system'::text NOT NULL,
    actor_id integer,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    seq bigint NOT NULL
);

ALTER TABLE ONLY public.giniflow_lab_order_events FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.giniflow_lab_order_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_lab_order_events_seq_seq OWNED BY public.giniflow_lab_order_events.seq;

CREATE TABLE public.giniflow_lab_order_tests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lab_order_id uuid NOT NULL,
    test_name text NOT NULL,
    price numeric(10,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'ordered'::text NOT NULL
);

ALTER TABLE ONLY public.giniflow_lab_order_tests FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_lab_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    ordered_by integer,
    urgency text DEFAULT 'today'::text NOT NULL,
    payment_status text DEFAULT 'pending'::text NOT NULL,
    amount_total numeric(10,2) DEFAULT 0 NOT NULL,
    sample_status text DEFAULT 'ordered'::text NOT NULL,
    report_file_url text,
    uploaded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    promoted_at timestamp with time zone,
    insurer text,
    policy_no text,
    claim_no text,
    claim_approved_by integer,
    amount_paid numeric(10,2) DEFAULT 0 NOT NULL,
    amount_claimed numeric(10,2) DEFAULT 0 NOT NULL,
    claim_state text DEFAULT 'none'::text NOT NULL,
    claim_note text,
    version integer DEFAULT 0 NOT NULL,
    scheme_code text,
    kind text DEFAULT 'lab'::text NOT NULL,
    CONSTRAINT giniflow_lab_orders_amounts_within_total CHECK (((amount_paid >= (0)::numeric) AND (amount_claimed >= (0)::numeric) AND ((amount_paid +
CASE
    WHEN (claim_state = 'rejected'::text) THEN (0)::numeric
    ELSE amount_claimed
END) <= amount_total))),
    CONSTRAINT giniflow_lab_orders_claim_state CHECK ((claim_state = ANY (ARRAY['none'::text, 'submitted'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT giniflow_lab_orders_kind_check CHECK ((kind = ANY (ARRAY['lab'::text, 'machine'::text])))
);

ALTER TABLE ONLY public.giniflow_lab_orders FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.giniflow_lab_orders.payment_status IS 'pending | paid | insurance_claim (submitted, gate CLOSED) | claim_approved (gate open)';

COMMENT ON COLUMN public.giniflow_lab_orders.promoted_at IS 'When the uploaded report was copied into `documents`. Null means it has not been.';

CREATE TABLE public.giniflow_patient_bills (
    patient_id integer NOT NULL,
    bill_date date NOT NULL,
    status text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    invoice_no text,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT giniflow_patient_bills_status_check CHECK ((status = ANY (ARRAY['billed'::text, 'no_bill'::text])))
);

ALTER TABLE ONLY public.giniflow_patient_bills FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    patient_id integer NOT NULL,
    to_doctor text,
    to_doctor_phone text,
    specialty text NOT NULL,
    hospital text,
    urgency text DEFAULT 'routine'::text NOT NULL,
    reason text,
    investigations text,
    letter_file_url text,
    letter_generated_at timestamp with time zone,
    letter_sent_at timestamp with time zone,
    sent_to text,
    appointment_date date,
    appointment_note text,
    status text DEFAULT 'created'::text NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    presenting_complaint text,
    requested_action text,
    allergy_status text DEFAULT 'not_known'::text NOT NULL,
    allergy_note text,
    ref_no bigint NOT NULL,
    response_note text,
    response_at timestamp with time zone,
    response_by text
);

ALTER TABLE ONLY public.giniflow_referrals FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.giniflow_referrals IS 'Gini Flow external referrals. Parallel to the status chain — never moves giniflow_visits.current_status. docs/gini-flow/19-REFERRALS-STATION-PLAN.md';

COMMENT ON COLUMN public.giniflow_referrals.letter_sent_at IS 'Stamped ONLY when a message actually left the building — MSG91 logs instead of sending until the template is approved, and this column is the idempotency guard.';

COMMENT ON COLUMN public.giniflow_referrals.status IS 'The LETTER''s journey, not the patient''s: appointment_booked means the external clinic gave a slot. Gini books nothing.';

COMMENT ON COLUMN public.giniflow_referrals.presenting_complaint IS 'What is happening now, in the referrer''s words. Rendered above the reason.';

COMMENT ON COLUMN public.giniflow_referrals.requested_action IS 'What the referrer is asking the specialist to DO — the expected outcome.';

COMMENT ON COLUMN public.giniflow_referrals.allergy_status IS 'none_known | not_known | known. Never blank: an empty allergy field reads as "none" on a letter.';

COMMENT ON COLUMN public.giniflow_referrals.allergy_note IS 'The allergy itself, when allergy_status = known. e.g. "Penicillin — rash".';

COMMENT ON COLUMN public.giniflow_referrals.ref_no IS 'Counter behind the printed REF-YYYY-NNNNNN. A label for humans; id remains the key.';

COMMENT ON COLUMN public.giniflow_referrals.response_note IS 'What the specialist said, in the words the desk was given. Free text on purpose.';

COMMENT ON COLUMN public.giniflow_referrals.response_at IS 'When the reply was recorded here — not when the specialist saw the patient.';

COMMENT ON COLUMN public.giniflow_referrals.response_by IS 'Who at Gini wrote it down. The specialist is already named by to_doctor.';

CREATE SEQUENCE public.giniflow_referrals_ref_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_referrals_ref_no_seq OWNED BY public.giniflow_referrals.ref_no;

CREATE TABLE public.giniflow_rx_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    source_medication_id integer,
    medicine_name text NOT NULL,
    pharmacy_match text,
    composition text,
    dose text,
    previous_dose text,
    frequency text,
    timing text,
    timing_category text,
    time_of_day time without time zone,
    route text DEFAULT 'Oral'::text,
    form text,
    duration text,
    reason text,
    patient_instruction text,
    change_type text DEFAULT 'new'::text NOT NULL,
    stop_reason text,
    resume_on date,
    drug_class text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    proposed_by integer,
    approval_status text,
    decided_by integer,
    decided_at timestamp with time zone,
    decision_note text,
    timing_categories text[],
    CONSTRAINT giniflow_rx_items_approval_status_check CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'adjusted'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.giniflow_rx_items FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_rx_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    medicine_name text NOT NULL,
    from_dose text,
    to_dose text,
    reason text,
    change_type text DEFAULT 'changed'::text NOT NULL,
    proposed_by integer,
    status text DEFAULT 'proposed'::text NOT NULL,
    decided_by integer,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.giniflow_rx_proposals FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_sd_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    plan text,
    source text DEFAULT 'typed'::text NOT NULL,
    authored_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reports_reviewed_at timestamp with time zone,
    reports_reviewed_by integer,
    reports_outcome text,
    reports_review_note text,
    CONSTRAINT giniflow_sd_notes_reports_outcome_chk CHECK (((reports_outcome IS NULL) OR (reports_outcome = ANY (ARRAY['normal'::text, 'needs_consultant'::text]))))
);

ALTER TABLE ONLY public.giniflow_sd_notes FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_sla_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    station text NOT NULL,
    label text NOT NULL,
    description text,
    budget_minutes integer NOT NULL,
    category_overrides jsonb,
    display_order integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT giniflow_sla_config_budget_minutes_check CHECK ((budget_minutes > 0))
);

ALTER TABLE ONLY public.giniflow_sla_config FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_test_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    test_name text NOT NULL,
    price numeric(10,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    source text DEFAULT 'prototype_placeholder'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gloss text,
    category text DEFAULT 'lab'::text NOT NULL,
    CONSTRAINT giniflow_test_catalog_category_check CHECK ((category = ANY (ARRAY['lab'::text, 'machine'::text])))
);

ALTER TABLE ONLY public.giniflow_test_catalog FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_test_panels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    panel_key text NOT NULL,
    label text NOT NULL,
    icon text,
    test_names text[] NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.giniflow_test_panels FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_triage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    action text NOT NULL,
    category text,
    assigned_sd_id integer,
    assigned_doctor_id integer,
    actor_id integer,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    seq bigint NOT NULL,
    note text
);

ALTER TABLE ONLY public.giniflow_triage_events FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.giniflow_triage_events IS 'Coordinator triage writes (categorise, assign). Insert-only, tailed for live updates. NOT read by any station timer — that is giniflow_visit_events.';

CREATE SEQUENCE public.giniflow_triage_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_triage_events_seq_seq OWNED BY public.giniflow_triage_events.seq;

CREATE TABLE public.giniflow_visit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    status text NOT NULL,
    actor_role text DEFAULT 'system'::text NOT NULL,
    actor_id integer,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    seq bigint NOT NULL
);

ALTER TABLE ONLY public.giniflow_visit_events FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.giniflow_visit_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_visit_events_seq_seq OWNED BY public.giniflow_visit_events.seq;

CREATE TABLE public.giniflow_visit_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    step_order integer NOT NULL,
    step_catalog_id text,
    step_name text NOT NULL,
    planned_duration_min integer DEFAULT 0 NOT NULL,
    station text,
    assigned_role text,
    assigned_staff_id text,
    assigned_staff_name text,
    chain_status text,
    status text DEFAULT 'pending'::text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    source text DEFAULT 'template'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT giniflow_visit_steps_source CHECK ((source = ANY (ARRAY['template'::text, 'added'::text, 'custom'::text, 'auto'::text]))),
    CONSTRAINT giniflow_visit_steps_status CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'done'::text, 'skipped'::text])))
);

ALTER TABLE ONLY public.giniflow_visit_steps FORCE ROW LEVEL SECURITY;

CREATE TABLE public.giniflow_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    visit_date date DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata'::text))::date NOT NULL,
    appointment_id integer,
    appointment_time time without time zone,
    current_status text DEFAULT 'booked'::text NOT NULL,
    results_status text DEFAULT 'none'::text NOT NULL,
    category text,
    blocked_reason text,
    assigned_sd_id integer,
    assigned_doctor_id integer,
    lifestyle_flagged boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    resume_status text,
    priority text DEFAULT 'normal'::text NOT NULL,
    queue_position integer,
    queue_column text,
    priority_reason text,
    priority_set_by integer,
    priority_set_at timestamp with time zone,
    card_sent_at timestamp with time zone,
    category_source text,
    category_set_by integer,
    category_set_at timestamp with time zone,
    merged_into_visit_id uuid,
    visit_type_id text,
    planned_total_min integer,
    visit_token text,
    whatsapp_sent boolean DEFAULT false NOT NULL,
    checked_in_by integer,
    paused_at timestamp with time zone,
    paused_by integer,
    paused_reason text,
    paused_ms_total bigint DEFAULT 0 NOT NULL,
    healthray_status text,
    healthray_status_at timestamp with time zone,
    behind_station text,
    machine_scan_at timestamp with time zone,
    CONSTRAINT giniflow_visits_blocked_invariant CHECK (((current_status = 'blocked_reports'::text) = (blocked_reason IS NOT NULL)))
);

ALTER TABLE ONLY public.giniflow_visits FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.giniflow_visits.card_sent_at IS 'When the medicine card was last sent to the patient on WhatsApp (Gini Flow pharmacy station).';

COMMENT ON COLUMN public.giniflow_visits.category_source IS 'auto | coordinator — who last set category. The auto sweep skips coordinator rows.';

CREATE TABLE public.giniflow_vitals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    visit_id uuid NOT NULL,
    patient_id integer NOT NULL,
    weight numeric(6,2),
    height numeric(6,2),
    bmi numeric(5,2),
    bp_sys integer,
    bp_dia integer,
    pulse integer,
    spo2 integer,
    temp numeric(5,2),
    source text DEFAULT 'manual'::text NOT NULL,
    recorded_by integer,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    promoted_at timestamp with time zone,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    seq bigint NOT NULL
);

ALTER TABLE ONLY public.giniflow_vitals FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.giniflow_vitals_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.giniflow_vitals_seq_seq OWNED BY public.giniflow_vitals.seq;

CREATE TABLE public.glp1_cohort (
    patient_id integer NOT NULL,
    glp1_drug text,
    glp1_brand text,
    current_dose text,
    max_dose text,
    frequency text,
    first_prescribed_date date,
    latest_consultation_date date,
    consultation_count integer,
    concurrent_dm_classes text[],
    concurrent_dm_drugs text[],
    baseline_hba1c numeric,
    latest_hba1c numeric,
    hba1c_delta numeric,
    at_target boolean,
    baseline_fbg numeric,
    latest_fbg numeric,
    fbg_delta numeric,
    complications_present text[],
    nephropathy_stage text,
    diagnoses text[],
    diet_kcal text,
    assessment text
);

ALTER TABLE ONLY public.glp1_cohort FORCE ROW LEVEL SECURITY;

CREATE TABLE public.goals (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    marker text,
    current_value text,
    target_value text,
    timeline text,
    priority text,
    status character varying(20) DEFAULT 'active'::character varying,
    achieved_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.goals FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.goals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.goals_id_seq OWNED BY public.goals.id;

CREATE TABLE public.l3_a1c_windows (
    patient_id integer,
    drug_class text,
    add_date date,
    a1c_baseline numeric,
    a1c_short numeric,
    a1c_medium numeric,
    a1c_long numeric
);

ALTER TABLE ONLY public.l3_a1c_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE public.l3_drug_events (
    patient_id integer,
    consultation_id integer,
    add_date date,
    drug_class text,
    add_visit_number bigint
);

ALTER TABLE ONLY public.l3_drug_events FORCE ROW LEVEL SECURITY;

CREATE TABLE public.l3_ldl_windows (
    patient_id integer,
    drug_class text,
    add_date date,
    ldl_baseline numeric,
    ldl_followup numeric
);

ALTER TABLE ONLY public.l3_ldl_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE public.l3_uacr_windows (
    patient_id integer,
    drug_class text,
    add_date date,
    uacr_baseline numeric,
    uacr_followup numeric
);

ALTER TABLE ONLY public.l3_uacr_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE public.l3_weight_windows (
    patient_id integer,
    drug_class text,
    add_date date,
    weight_baseline numeric,
    weight_medium numeric,
    weight_long numeric
);

ALTER TABLE ONLY public.l3_weight_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE public.lab_cases (
    id integer NOT NULL,
    case_no text NOT NULL,
    patient_case_no text NOT NULL,
    case_uid text NOT NULL,
    lab_case_id integer NOT NULL,
    lab_user_id integer,
    patient_id integer,
    appointment_id integer,
    lab_branch_id integer DEFAULT 226,
    test_names text[],
    case_date date,
    case_status text,
    pdf_file_name text,
    results_synced boolean DEFAULT false,
    raw_list_json jsonb,
    raw_detail_json jsonb,
    fetched_at timestamp with time zone DEFAULT now(),
    synced_at timestamp with time zone,
    investigation_summary jsonb,
    case_source text,
    retry_count integer DEFAULT 0,
    last_retry_at timestamp with time zone,
    retry_abandoned boolean DEFAULT false,
    pdf_storage_path text,
    pdf_unavailable boolean DEFAULT false,
    pdf_attempt_count integer DEFAULT 0,
    pdf_first_attempt_at timestamp with time zone,
    pdf_last_attempt_at timestamp with time zone,
    pdf_next_attempt_at timestamp with time zone,
    pdf_blank_checked_at timestamp with time zone
);

ALTER TABLE ONLY public.lab_cases FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.lab_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lab_cases_id_seq OWNED BY public.lab_cases.id;

CREATE SEQUENCE public.lab_catalog_manual_id_seq
    START WITH 900000000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.lab_report_catalog (
    id bigint DEFAULT nextval('public.lab_catalog_manual_id_seq'::regclass) NOT NULL,
    name text NOT NULL,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    edited_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lab_report_catalog_source_check CHECK ((source = ANY (ARRAY['healthray'::text, 'manual'::text])))
);

CREATE TABLE public.lab_report_tests (
    report_id bigint NOT NULL,
    test_id bigint NOT NULL,
    sequence integer DEFAULT 0 NOT NULL,
    is_required boolean DEFAULT true NOT NULL
);

CREATE TABLE public.lab_results (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    test_date date DEFAULT CURRENT_DATE,
    panel_name character varying(100),
    test_name text NOT NULL,
    result numeric,
    result_text character varying(200),
    unit text,
    flag text,
    ref_range text,
    is_critical boolean DEFAULT false,
    source text DEFAULT 'scribe'::character varying,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    canonical_name text,
    appointment_id integer,
    document_id integer,
    genie_id uuid,
    lab_order_id uuid,
    lab_case_no text
);

ALTER TABLE ONLY public.lab_results FORCE ROW LEVEL SECURITY;

CREATE TABLE public.lab_results_appt_unlink_backup_20260430 (
    lab_id bigint NOT NULL,
    prior_appointment_id integer NOT NULL,
    lab_test_date date,
    appt_date date,
    gap_days integer,
    backed_up_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.lab_results_appt_unlink_backup_20260430 FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.lab_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lab_results_id_seq OWNED BY public.lab_results.id;

CREATE TABLE public.lab_test_catalog (
    id bigint DEFAULT nextval('public.lab_catalog_manual_id_seq'::regclass) NOT NULL,
    parent_test_id bigint,
    sequence integer,
    name text NOT NULL,
    unit text,
    input_type text DEFAULT 'numeric'::text NOT NULL,
    formula text,
    canonical_name text,
    is_active boolean DEFAULT true NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    edited_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lab_test_catalog_input_type_check CHECK ((input_type = ANY (ARRAY['numeric'::text, 'text'::text, 'group'::text]))),
    CONSTRAINT lab_test_catalog_source_check CHECK ((source = ANY (ARRAY['healthray'::text, 'manual'::text])))
);

CREATE TABLE public.lab_test_mapping (
    raw_name text NOT NULL,
    canonical_name text NOT NULL,
    category text,
    unit text,
    normal_low numeric,
    normal_high numeric
);

ALTER TABLE ONLY public.lab_test_mapping FORCE ROW LEVEL SECURITY;

CREATE TABLE public.lab_test_ranges (
    id bigint NOT NULL,
    test_id bigint NOT NULL,
    gender text DEFAULT 'Both'::text NOT NULL,
    min_age_days integer DEFAULT 0 NOT NULL,
    max_age_days integer DEFAULT 36500 NOT NULL,
    min_value numeric,
    max_value numeric,
    min_critical numeric,
    max_critical numeric,
    text_range text,
    is_pregnant boolean DEFAULT false NOT NULL,
    healthray_ref_id bigint,
    source text DEFAULT 'manual'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lab_test_ranges_gender_check CHECK ((gender = ANY (ARRAY['Both'::text, 'Male'::text, 'Female'::text]))),
    CONSTRAINT lab_test_ranges_source_check CHECK ((source = ANY (ARRAY['healthray'::text, 'manual'::text])))
);

CREATE SEQUENCE public.lab_test_ranges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lab_test_ranges_id_seq OWNED BY public.lab_test_ranges.id;

CREATE TABLE public.lab_test_requests (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    test_names text[] NOT NULL,
    collection_type text NOT NULL,
    address_house text,
    address_street text,
    address_landmark text,
    address_pincode text,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT lab_request_home_needs_address CHECK (((collection_type <> 'home'::text) OR ((address_house IS NOT NULL) AND (length(TRIM(BOTH FROM address_house)) > 0) AND (address_street IS NOT NULL) AND (length(TRIM(BOTH FROM address_street)) > 0) AND (address_landmark IS NOT NULL) AND (length(TRIM(BOTH FROM address_landmark)) > 0) AND (address_pincode ~ '^[0-9]{6}$'::text)))),
    CONSTRAINT lab_test_requests_collection_type_check CHECK ((collection_type = ANY (ARRAY['hospital'::text, 'home'::text]))),
    CONSTRAINT lab_test_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.lab_test_requests FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.lab_test_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lab_test_requests_id_seq OWNED BY public.lab_test_requests.id;

CREATE TABLE public.layer3_outcomes (
    patient_id integer,
    drug_class text,
    add_date date,
    add_visit_number bigint,
    age integer,
    sex text,
    a1c_baseline numeric,
    a1c_short numeric,
    a1c_medium numeric,
    a1c_long numeric,
    a1c_delta_short numeric,
    a1c_delta_medium numeric,
    a1c_delta_long numeric,
    weight_baseline numeric,
    weight_medium numeric,
    weight_delta_medium_kg numeric,
    ldl_baseline numeric,
    ldl_followup numeric,
    ldl_delta numeric,
    uacr_baseline numeric,
    uacr_followup numeric,
    uacr_pct_change numeric,
    reached_target_medium boolean,
    reached_target_long boolean,
    followup_sufficiency text
);

ALTER TABLE ONLY public.layer3_outcomes FORCE ROW LEVEL SECURITY;

CREATE TABLE public.lead_campaigns (
    id integer NOT NULL,
    name text NOT NULL,
    platform text,
    external_id text,
    started_on date,
    ended_on date,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.lead_campaigns FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.lead_campaigns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lead_campaigns_id_seq OWNED BY public.lead_campaigns.id;

CREATE TABLE public.lead_events (
    id integer NOT NULL,
    lead_id integer NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    actor text,
    payload jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT lead_events_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'call'::text, 'note'::text, 'status_change'::text, 'assigned'::text, 'whatsapp_out'::text, 'whatsapp_in'::text, 'booked'::text, 'converted'::text, 'lost'::text, 'merged'::text])))
);

ALTER TABLE ONLY public.lead_events FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.lead_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lead_events_id_seq OWNED BY public.lead_events.id;

CREATE TABLE public.leads (
    id integer NOT NULL,
    name text NOT NULL,
    phone text,
    alt_phone text,
    email text,
    city text,
    source text DEFAULT 'enquiry_call'::text NOT NULL,
    source_detail text,
    campaign_id integer,
    interest text,
    status text DEFAULT 'new'::text NOT NULL,
    lost_reason text,
    owner_doctor_id integer,
    first_response_at timestamp with time zone,
    next_action_at timestamp with time zone,
    patient_id integer,
    appointment_id integer,
    consent_marketing boolean DEFAULT false,
    merged_into_id integer,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT leads_source_check CHECK ((source = ANY (ARRAY['enquiry_call'::text, 'walk_in'::text, 'web_form'::text, 'ad_campaign'::text, 'referral_doctor'::text, 'referral_patient'::text, 'genie_install'::text, 'whatsapp'::text, 'other'::text]))),
    CONSTRAINT leads_status_check CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'qualified'::text, 'booked'::text, 'converted'::text, 'lost'::text, 'duplicate'::text])))
);

ALTER TABLE ONLY public.leads FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.leads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.leads_id_seq OWNED BY public.leads.id;

CREATE TABLE public.meal_logs (
    id bigint NOT NULL,
    patient_id integer NOT NULL,
    meal_type text,
    description text,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    calories real,
    protein_g real,
    carbs_g real,
    fat_g real,
    fiber_g real,
    sugar_g real,
    sodium_mg real,
    source text DEFAULT 'patient_app'::text,
    source_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    potassium_mg numeric,
    calcium_mg numeric,
    iron_mg numeric,
    vitamin_c_mg numeric,
    pros text[],
    cons text[]
);

ALTER TABLE ONLY public.meal_logs FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.meal_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.meal_logs_id_seq OWNED BY public.meal_logs.id;

CREATE TABLE public.medication_adherence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    medication_name text NOT NULL,
    log_date date NOT NULL,
    taken boolean NOT NULL,
    dose_time text,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.medication_adherence FORCE ROW LEVEL SECURITY;

CREATE TABLE public.medication_dose_change_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    medication_id text NOT NULL,
    medication_name text NOT NULL,
    current_dose text NOT NULL,
    requested_dose text,
    final_dose text,
    dose_unit text,
    patient_reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    doctor_id text,
    doctor_note text,
    reject_reason text,
    initiated_by text DEFAULT 'patient'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT medication_dose_change_requests_initiated_by_check CHECK ((initiated_by = ANY (ARRAY['patient'::text, 'doctor'::text]))),
    CONSTRAINT medication_dose_change_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.medication_dose_change_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE public.medication_refill_request_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    medication_name text NOT NULL,
    dose text,
    timing text,
    quantity integer NOT NULL,
    source_medication_id text,
    CONSTRAINT medication_refill_request_items_quantity_check CHECK ((quantity > 0))
);

ALTER TABLE ONLY public.medication_refill_request_items FORCE ROW LEVEL SECURITY;

CREATE TABLE public.medication_refill_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    status_updated_at timestamp with time zone,
    status_updated_by text,
    reject_reason text
);

ALTER TABLE ONLY public.medication_refill_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE public.medications (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    name text NOT NULL,
    pharmacy_match text,
    composition text,
    dose text,
    frequency text,
    timing text,
    route text DEFAULT 'Oral'::character varying,
    for_diagnosis text[],
    is_new boolean DEFAULT false,
    is_active boolean DEFAULT true,
    started_date date,
    stopped_date date,
    stop_reason character varying(200),
    side_effects text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    drug_master_id integer,
    drug_class text,
    category text,
    action text,
    previous_dose text,
    prescriber text,
    appointment_id integer,
    source text,
    document_id integer,
    updated_at timestamp with time zone DEFAULT now(),
    med_group text,
    external_doctor text,
    clinical_note text,
    sort_order integer DEFAULT 0,
    history jsonb DEFAULT '[]'::jsonb,
    last_prescribed_date date,
    parent_medication_id integer,
    support_condition text,
    visit_status text,
    reminder_times jsonb DEFAULT '[]'::jsonb,
    days_of_week integer[],
    common_side_effects jsonb DEFAULT '[]'::jsonb,
    when_to_take public.when_to_take_pill[],
    instructions text,
    patient_notes text,
    form text,
    timing_category text,
    time_of_day time without time zone,
    change_type text,
    external_specialty text,
    external_hospital text,
    external_condition text,
    interaction_flag text,
    CONSTRAINT medications_visit_status_check CHECK ((visit_status = ANY (ARRAY['current'::text, 'previous'::text])))
);

ALTER TABLE ONLY public.medications FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.medications.external_specialty IS 'The outside prescriber''s specialty. Meaningful only alongside external_doctor.';

COMMENT ON COLUMN public.medications.external_hospital IS 'Where the outside prescriber practises.';

COMMENT ON COLUMN public.medications.external_condition IS 'What the outside prescriber is treating with it — the patient''s answer, not a diagnosis code.';

COMMENT ON COLUMN public.medications.interaction_flag IS 'A checked interaction, written by a human. Never generated: an unchecked pair must look unchecked.';

CREATE SEQUENCE public.medications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.medications_id_seq OWNED BY public.medications.id;

CREATE TABLE public.medicine_catalog (
    id integer NOT NULL,
    name text NOT NULL,
    price numeric(10,2),
    is_active boolean DEFAULT true NOT NULL,
    source text DEFAULT 'unpriced'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT medicine_catalog_price_check CHECK (((price IS NULL) OR (price >= (0)::numeric)))
);

CREATE SEQUENCE public.medicine_catalog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.medicine_catalog_id_seq OWNED BY public.medicine_catalog.id;

CREATE TABLE public.medicine_collections (
    id integer NOT NULL,
    medication_id integer NOT NULL,
    patient_id integer NOT NULL,
    appointment_id integer,
    collected_date date DEFAULT CURRENT_DATE NOT NULL,
    status text NOT NULL,
    reason text,
    qty_note text,
    marked_by text,
    marked_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT medicine_collections_status_check CHECK ((status = ANY (ARRAY['given'::text, 'not_given'::text, 'partial'::text])))
);

ALTER TABLE ONLY public.medicine_collections FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.medicine_collections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.medicine_collections_id_seq OWNED BY public.medicine_collections.id;

CREATE TABLE public.mhg_clinical_protocols (
    id integer NOT NULL,
    protocol_id text NOT NULL,
    category text NOT NULL,
    protocol_type text DEFAULT 'recommendation'::text NOT NULL,
    priority integer DEFAULT 5 NOT NULL,
    phenotype text,
    scenario text NOT NULL,
    a1c_min numeric,
    a1c_max numeric,
    egfr_min numeric,
    egfr_max numeric,
    comorbidity_flags text[],
    recommended_drugs text[],
    drugs_to_avoid text[],
    dose_notes text,
    monitoring text,
    evidence_source text,
    evidence_detail text,
    confidence_level text,
    requires_review boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    notes text
);

ALTER TABLE ONLY public.mhg_clinical_protocols FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.mhg_clinical_protocols_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.mhg_clinical_protocols_id_seq OWNED BY public.mhg_clinical_protocols.id;

CREATE TABLE public.mhg_drug_formulary (
    id integer NOT NULL,
    drug_class text NOT NULL,
    molecule text NOT NULL,
    brand text NOT NULL,
    manufacturer text,
    formulation text NOT NULL,
    route text DEFAULT 'oral'::text,
    cost_tier text DEFAULT 'standard'::text,
    is_combo boolean DEFAULT false,
    combo_components text[],
    preferred_if text,
    dose_selection_rules jsonb DEFAULT '{}'::jsonb,
    avoid_if text[],
    egfr_min numeric,
    age_max integer,
    substitute_with text,
    substitute_reason text,
    starting_dose text,
    uptitration text,
    max_dose text,
    timing text,
    notes text,
    patent_status text DEFAULT 'originator'::text,
    available_in_india boolean DEFAULT true,
    last_updated date DEFAULT CURRENT_DATE
);

ALTER TABLE ONLY public.mhg_drug_formulary FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.mhg_drug_formulary_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.mhg_drug_formulary_id_seq OWNED BY public.mhg_drug_formulary.id;

CREATE TABLE public.mhg_vitals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gini_patient_id text NOT NULL,
    source_id text,
    recorded_at timestamp with time zone DEFAULT now(),
    bp_sys numeric,
    bp_dia numeric,
    pulse numeric,
    spo2 numeric,
    weight numeric,
    height numeric,
    temperature numeric,
    source text DEFAULT 'doctor'::text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.mhg_vitals FORCE ROW LEVEL SECURITY;

CREATE TABLE public.obt_call_status (
    id integer NOT NULL,
    appointment_id integer,
    call_date date DEFAULT CURRENT_DATE NOT NULL,
    appointment_date date,
    appointment_time text,
    file_no text,
    patient_name text,
    gender text,
    dob text,
    mobile text,
    address text,
    visit_type text,
    condition text,
    chief_complaint text,
    mo_assigned text,
    call_status text DEFAULT 'Pending'::text,
    suggested_blood_test text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.obt_call_status FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.obt_call_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.obt_call_status_id_seq OWNED BY public.obt_call_status.id;

CREATE TABLE public.patient_activity_log (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    genie_id text,
    activity_type text NOT NULL,
    value text,
    value2 text,
    context text,
    duration_minutes real,
    mood_score real,
    log_date date NOT NULL,
    log_time text,
    source text DEFAULT 'genie'::text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone
);

ALTER TABLE ONLY public.patient_activity_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_activity_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_activity_log_id_seq OWNED BY public.patient_activity_log.id;

CREATE TABLE public.patient_block_log (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    action text NOT NULL,
    reason_code text,
    note text,
    actor_name text,
    actor_id integer,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_block_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_block_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_block_log_id_seq OWNED BY public.patient_block_log.id;

CREATE TABLE public.patient_briefs (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    brief_type character varying(20) DEFAULT 'clinical'::character varying,
    content jsonb,
    generated_at timestamp with time zone DEFAULT now(),
    data_hash character varying(64),
    version integer DEFAULT 1,
    trigger_source character varying(50)
);

ALTER TABLE ONLY public.patient_briefs FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_briefs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_briefs_id_seq OWNED BY public.patient_briefs.id;

CREATE TABLE public.patient_conditions_genie (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    genie_id text,
    name text,
    status text,
    diagnosed_date date,
    notes text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone
);

ALTER TABLE ONLY public.patient_conditions_genie FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_conditions_genie_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_conditions_genie_id_seq OWNED BY public.patient_conditions_genie.id;

CREATE VIEW public.patient_diabetes_profile WITH (security_invoker='on') AS
 SELECT patient_id,
    visit_date,
        CASE
            WHEN ("substring"(con_transcript, 'SINCE\s+(\d{4})'::text) IS NOT NULL) THEN ((EXTRACT(year FROM visit_date))::integer - ("substring"(con_transcript, 'SINCE\s+(\d{4})'::text))::integer)
            ELSE NULL::integer
        END AS disease_duration_years,
    "substring"(con_transcript, 'SINCE\s+(\d{4})'::text) AS onset_year,
    (NULLIF("substring"(upper(con_transcript), 'AOO\s*[:\-]?\s*(\d+)\s*(?:YRS|YEARS)?'::text), ''::text))::integer AS age_of_onset,
        CASE
            WHEN (("substring"(upper(con_transcript), 'AOO\s*[:\-]?\s*(\d+)\s*(?:YRS|YEARS)?'::text))::integer < 30) THEN true
            WHEN (upper(con_transcript) ~~ '%EARLY ONSET%'::text) THEN true
            ELSE false
        END AS early_onset,
        CASE
            WHEN (upper(con_transcript) ~~ '%DUAL ADIPOSITY%'::text) THEN 'dual_adiposity'::text
            WHEN (upper(con_transcript) ~~ '%CENTRAL ADIPOSITY%'::text) THEN 'central_adiposity'::text
            WHEN (upper(con_transcript) ~~ '%NON OBESE%'::text) THEN 'non_obese'::text
            ELSE NULL::text
        END AS body_phenotype,
        CASE
            WHEN (con_transcript ~* 'NEUROPATHY\s*\+'::text) THEN 'positive'::text
            WHEN (con_transcript ~* 'NEUROPATHY\s*\-'::text) THEN 'negative'::text
            ELSE NULL::text
        END AS neuropathy,
        CASE
            WHEN (con_transcript ~* 'NEPHROPATHY\s*\+'::text) THEN 'positive'::text
            WHEN (con_transcript ~* 'NEPHROPATHY\s*\-'::text) THEN 'negative'::text
            ELSE NULL::text
        END AS nephropathy,
    "substring"(upper(con_transcript), 'NEPHROPATHY\s*\(?(G[1-5]A[1-3])'::text) AS ckd_stage,
        CASE
            WHEN (con_transcript ~* 'RETINOPATHY\s*\+'::text) THEN 'positive'::text
            WHEN (con_transcript ~* 'RETINOPATHY\s*\-'::text) THEN 'negative'::text
            ELSE NULL::text
        END AS retinopathy
   FROM public.consultations
  WHERE (con_name = ANY (ARRAY['Dr. Bhansali'::text, 'Dr. Anil Bhansali'::text]));

CREATE TABLE public.patient_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer,
    doc_type text NOT NULL,
    title text,
    file_url text,
    source text,
    source_id text,
    doctor_name text,
    hospital_name text,
    document_date date,
    parsed_data jsonb,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_documents FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_drug_history (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    drug_class text NOT NULL,
    brand text,
    molecule text,
    started_date date,
    stopped_date date,
    stopped_reason text,
    contraindicated boolean DEFAULT false,
    caution boolean DEFAULT false,
    notes text,
    recorded_by text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_drug_history FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_drug_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_drug_history_id_seq OWNED BY public.patient_drug_history.id;

CREATE TABLE public.patient_health_model (
    patient_id integer NOT NULL,
    name text,
    age integer,
    sex text,
    current_a1c numeric,
    current_fbg numeric,
    current_bmi numeric,
    current_egfr numeric,
    current_ldl numeric,
    current_tsh numeric,
    current_bp_sys integer,
    c_peptide numeric,
    homa_ir numeric,
    a1c_start numeric,
    a1c_change numeric,
    a1c_trend text,
    weight_start numeric,
    weight_now numeric,
    weight_change numeric,
    total_visits integer,
    current_regimen text,
    drug_classes_active text,
    best_a1c_ever numeric,
    worst_a1c_ever numeric,
    active_diagnoses text,
    risk_score integer,
    treatment_gaps text,
    last_visit date,
    days_since_visit integer
);

ALTER TABLE ONLY public.patient_health_model FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_insights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer,
    memory_type text DEFAULT 'pattern'::text,
    category text DEFAULT 'general'::text,
    insight text NOT NULL,
    confidence double precision DEFAULT 0.5,
    times_observed integer DEFAULT 1,
    source text DEFAULT 'check-in'::text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_insights FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_meal_log (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    genie_id text,
    meal_type text,
    description text,
    calories real,
    protein_g real,
    carbs_g real,
    fat_g real,
    log_date date NOT NULL,
    source text DEFAULT 'genie'::text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone
);

ALTER TABLE ONLY public.patient_meal_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_meal_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_meal_log_id_seq OWNED BY public.patient_meal_log.id;

CREATE TABLE public.patient_med_log (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    genie_id text,
    medication_name text,
    medication_dose text,
    genie_medication_id text,
    log_date date NOT NULL,
    dose_time text,
    status text,
    source text DEFAULT 'genie'::text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone
);

ALTER TABLE ONLY public.patient_med_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_med_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_med_log_id_seq OWNED BY public.patient_med_log.id;

CREATE TABLE public.patient_med_streak (
    patient_id integer NOT NULL,
    streak_count integer DEFAULT 0 NOT NULL,
    last_date date
);

ALTER TABLE ONLY public.patient_med_streak FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_medications_genie (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    genie_id text,
    name text,
    dose text,
    frequency text,
    timing text,
    instructions text,
    is_active boolean DEFAULT true,
    for_conditions text[],
    source text DEFAULT 'genie'::text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone
);

ALTER TABLE ONLY public.patient_medications_genie FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_medications_genie_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_medications_genie_id_seq OWNED BY public.patient_medications_genie.id;

CREATE TABLE public.patient_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    mhg_message_id uuid,
    direction text NOT NULL,
    message text,
    sender_name text,
    is_read boolean DEFAULT false,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    sender text DEFAULT 'doctor'::text,
    sender_role text,
    conversation_id uuid,
    attachment_path text,
    attachment_mime text,
    attachment_name text,
    message_type text DEFAULT 'chat'::text NOT NULL
);

ALTER TABLE ONLY public.patient_messages FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_metabolic_profile (
    patient_id integer NOT NULL,
    age integer,
    sex text,
    baseline_a1c numeric,
    latest_a1c numeric,
    a1c_delta numeric,
    a1c_trend text,
    a1c_readings integer DEFAULT 0,
    baseline_fbg numeric,
    latest_fbg numeric,
    c_peptide numeric,
    homa_ir numeric,
    homa_beta numeric,
    fasting_insulin numeric,
    baseline_weight numeric,
    latest_weight numeric,
    weight_delta numeric,
    weight_trend text,
    latest_bmi numeric,
    waist numeric,
    body_fat_pct numeric,
    bmi_category text,
    latest_ldl numeric,
    latest_hdl numeric,
    latest_tg numeric,
    latest_tc numeric,
    latest_non_hdl numeric,
    latest_apob numeric,
    latest_egfr numeric,
    latest_uacr numeric,
    latest_creatinine numeric,
    ckd_stage text,
    latest_tsh numeric,
    latest_hemoglobin numeric,
    latest_vitamin_d numeric,
    bp_systolic numeric,
    bp_diastolic numeric,
    dm_since_year integer,
    dm_duration_years integer,
    metabolic_phenotype text,
    risk_score integer,
    data_completeness integer DEFAULT 0,
    has_diabetes boolean DEFAULT false,
    has_hypertension boolean DEFAULT false,
    has_thyroid boolean DEFAULT false,
    has_ckd boolean DEFAULT false,
    has_dyslipidemia boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    baseline_egfr numeric,
    baseline_ldl numeric,
    baseline_tsh numeric,
    baseline_tg numeric
);

ALTER TABLE ONLY public.patient_metabolic_profile FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_phenotype (
    patient_id integer,
    name character varying(200),
    age integer,
    sex text,
    file_no character varying(50),
    bmi numeric,
    weight numeric,
    a1c numeric,
    tg numeric,
    egfr numeric,
    uacr numeric,
    nephropathy_grade integer,
    ckd_status text,
    primary_phenotype text,
    renal_screening_gap_flag boolean
);

ALTER TABLE ONLY public.patient_phenotype FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    fcm_token text NOT NULL,
    platform text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.patient_push_tokens FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_reported_side_effects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    medication_id text,
    medication_name text,
    name text NOT NULL,
    description text,
    severity text DEFAULT 'common'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    source text DEFAULT 'custom'::text NOT NULL,
    patient_note text,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT patient_reported_side_effects_severity_check CHECK ((severity = ANY (ARRAY['common'::text, 'uncommon'::text, 'warn'::text]))),
    CONSTRAINT patient_reported_side_effects_source_check CHECK ((source = ANY (ARRAY['curated'::text, 'custom'::text]))),
    CONSTRAINT patient_reported_side_effects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.patient_reported_side_effects FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_schemes (
    code text NOT NULL,
    label text NOT NULL,
    color text DEFAULT 'gray'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    requires_ref boolean DEFAULT false NOT NULL,
    daily_cap integer,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT patient_schemes_daily_cap_check CHECK (((daily_cap IS NULL) OR (daily_cap >= 0)))
);

CREATE TABLE public.patient_special_alerts (
    id integer NOT NULL,
    file_no text,
    patient_id integer,
    patient_name text,
    alert_type text DEFAULT 'scheduling'::text NOT NULL,
    remarks text NOT NULL,
    preferred_slots text,
    additional_doctor text,
    priority_patient boolean DEFAULT false,
    preferred_date text,
    avoid_booking boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_special_alerts FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_special_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_special_alerts_id_seq OWNED BY public.patient_special_alerts.id;

CREATE TABLE public.patient_summaries (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    appointment_id integer,
    version integer NOT NULL,
    content text NOT NULL,
    change_note text,
    prev_version_id integer,
    author_name text,
    author_id text,
    source text,
    created_at timestamp with time zone DEFAULT now(),
    heading_greeting text,
    heading_accent text
);

ALTER TABLE ONLY public.patient_summaries FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_summaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_summaries_id_seq OWNED BY public.patient_summaries.id;

CREATE TABLE public.patient_symptom_log (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    genie_id text,
    symptom text NOT NULL,
    severity real,
    body_area text,
    context text,
    notes text,
    follow_up_needed boolean DEFAULT false,
    log_date date NOT NULL,
    log_time text,
    source text DEFAULT 'genie'::text,
    synced_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone
);

ALTER TABLE ONLY public.patient_symptom_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_symptom_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_symptom_log_id_seq OWNED BY public.patient_symptom_log.id;

CREATE TABLE public.patient_treatment_history (
    patient_id integer NOT NULL,
    drug_classes_tried text[] DEFAULT '{}'::text[],
    total_classes_tried integer DEFAULT 0,
    on_metformin boolean DEFAULT false,
    on_sulfonylurea boolean DEFAULT false,
    on_dpp4i boolean DEFAULT false,
    on_sglt2i boolean DEFAULT false,
    on_glp1 boolean DEFAULT false,
    glp1_drug text,
    on_insulin boolean DEFAULT false,
    insulin_type text,
    on_pioglitazone boolean DEFAULT false,
    on_statin boolean DEFAULT false,
    on_arb_acei boolean DEFAULT false,
    total_active_meds integer DEFAULT 0,
    total_ever_prescribed integer DEFAULT 0,
    total_stopped integer DEFAULT 0,
    total_dose_changes integer DEFAULT 0,
    treatment_intensity text,
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_treatment_history FORCE ROW LEVEL SECURITY;

CREATE TABLE public.patient_vitals (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    visit_date date,
    weight_kg numeric,
    height_cm numeric,
    bmi numeric,
    body_fat_pct numeric,
    waist_cm numeric,
    bp_systolic integer,
    bp_diastolic integer,
    bp_standing_systolic integer,
    bp_standing_diastolic integer,
    source text DEFAULT 'transcript_regex'::text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.patient_vitals FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_vitals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_vitals_id_seq OWNED BY public.patient_vitals.id;

CREATE TABLE public.patient_vitals_log (
    id integer NOT NULL,
    patient_id integer,
    bp_systolic integer,
    bp_diastolic integer,
    pulse integer,
    temp double precision,
    spo2 integer,
    weight_kg double precision,
    height double precision,
    created_at timestamp with time zone DEFAULT now(),
    genie_id text,
    recorded_date date,
    reading_time text,
    meal_type text,
    source text DEFAULT 'genie'::text,
    synced_at timestamp with time zone DEFAULT now(),
    rbs real,
    body_fat real,
    muscle_mass real,
    bmi real,
    waist real
);

ALTER TABLE ONLY public.patient_vitals_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.patient_vitals_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patient_vitals_log_id_seq OWNED BY public.patient_vitals_log.id;

CREATE SEQUENCE public.patients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.patients_id_seq OWNED BY public.patients.id;

CREATE TABLE public.pharmacy_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    medicine_name text NOT NULL,
    generic_name text,
    drug_class text,
    stock_qty integer,
    reorder_level integer,
    price_per_unit numeric(10,2),
    alternatives text[] DEFAULT '{}'::text[] NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.pharmacy_inventory FORCE ROW LEVEL SECURITY;

CREATE TABLE public.referrals (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    doctor_name text,
    speciality text,
    reason text,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    appointment_id integer
);

ALTER TABLE ONLY public.referrals FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.referrals IS 'OUTBOUND referral: a Gini doctor referring a patient OUT to an external specialist. Scribe clinical workflow. The inbound counterpart -- doctors sending patients TO Gini -- is crm.doctor_referrals.';

CREATE SEQUENCE public.referrals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.referrals_id_seq OWNED BY public.referrals.id;

CREATE TABLE public.refresh_tokens (
    id integer NOT NULL,
    kind text DEFAULT 'doctor'::text NOT NULL,
    doctor_id integer,
    patient_db text,
    patient_ref text,
    token_hash text NOT NULL,
    family_id text NOT NULL,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_agent text,
    ip text,
    CONSTRAINT refresh_tokens_check CHECK ((((kind = 'doctor'::text) AND (doctor_id IS NOT NULL)) OR ((kind = 'patient'::text) AND (patient_ref IS NOT NULL))))
);

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;

CREATE TABLE public.rx_review_feedback (
    id integer NOT NULL,
    consultation_id integer NOT NULL,
    patient_id integer NOT NULL,
    doctor_id integer,
    doctor_name text,
    ai_rx_analysis text NOT NULL,
    ai_model text,
    agreement_level text NOT NULL,
    feedback_text text,
    correct_approach text,
    reason_for_difference text,
    feedback_audio_url text,
    feedback_audio_transcript text,
    disagreement_tags text[],
    primary_condition text,
    medications_involved text[],
    severity text,
    reviewed_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT rx_review_feedback_agreement_level_check CHECK ((agreement_level = ANY (ARRAY['agree'::text, 'partially_agree'::text, 'disagree'::text]))),
    CONSTRAINT rx_review_feedback_severity_check CHECK ((severity = ANY (ARRAY['minor'::text, 'moderate'::text, 'major'::text])))
);

ALTER TABLE ONLY public.rx_review_feedback FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.rx_review_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rx_review_feedback_id_seq OWNED BY public.rx_review_feedback.id;

CREATE TABLE public.scheme_cap_overrides (
    id integer NOT NULL,
    scheme_code text NOT NULL,
    appointment_date date NOT NULL,
    booked_at_override integer NOT NULL,
    cap_at_override integer NOT NULL,
    appointment_id integer,
    overridden_by integer,
    overridden_by_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.scheme_cap_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.scheme_cap_overrides_id_seq OWNED BY public.scheme_cap_overrides.id;

CREATE TABLE public.scheme_medicine_prices (
    scheme_code text NOT NULL,
    medicine_name text NOT NULL,
    price numeric(10,2) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheme_medicine_prices_price_check CHECK ((price >= (0)::numeric))
);

CREATE TABLE public.scheme_opd_fees (
    scheme_code text NOT NULL,
    doctor_id integer,
    visit_type text NOT NULL,
    fee numeric(10,2) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheme_opd_fees_fee_check CHECK ((fee >= (0)::numeric))
);

CREATE TABLE public.scheme_test_prices (
    scheme_code text NOT NULL,
    test_name text NOT NULL,
    price numeric(10,2) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheme_test_prices_price_check CHECK ((price >= (0)::numeric))
);

CREATE TABLE public.slot_catalog (
    id integer NOT NULL,
    label text NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    sort_order integer NOT NULL,
    is_active boolean DEFAULT true
);

ALTER TABLE ONLY public.slot_catalog FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.slot_catalog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.slot_catalog_id_seq OWNED BY public.slot_catalog.id;

CREATE TABLE public.station_tracking (
    id integer NOT NULL,
    appointment_id integer,
    patient_id integer,
    visit_date date DEFAULT CURRENT_DATE NOT NULL,
    doctor_name text,
    cc_name text,
    ghm_checkin_time timestamp with time zone,
    patient_greet_time timestamp with time zone,
    last_updated_status text,
    last_updated_time timestamp with time zone,
    vitals_planned time without time zone,
    vitals_checkin timestamp with time zone,
    vitals_checkout timestamp with time zone,
    rx_planned time without time zone,
    rx_checkin timestamp with time zone,
    rx_checkout timestamp with time zone,
    rx_explained_by text,
    dm_planned time without time zone,
    dm_checkin timestamp with time zone,
    dm_checkout timestamp with time zone,
    ce_planned time without time zone,
    ce_checkin timestamp with time zone,
    ce_checkout timestamp with time zone,
    counsel_planned time without time zone,
    counsel_checkin timestamp with time zone,
    counsel_checkout timestamp with time zone,
    journey_time_mins integer,
    reasons_for_waiting text,
    followup_appt_booked boolean,
    followup_appt_no_reason text,
    followup_appt_date date,
    followup_appt_time text,
    followup_appt_with text,
    enrolled_in_programs text,
    weight_loss_medicine boolean DEFAULT false,
    followup_consult_other text,
    to_be_seen_by_bhansali boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.station_tracking FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.station_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.station_tracking_id_seq OWNED BY public.station_tracking.id;

CREATE TABLE public.symptom_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    symptom text NOT NULL,
    severity integer,
    body_area text,
    is_medication_side_effect boolean DEFAULT false,
    suspected_medication text,
    log_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.symptom_logs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.treatment_events (
    id integer NOT NULL,
    patient_id text NOT NULL,
    consultation_id text,
    protocol_id text,
    drug_added text,
    drug_stopped text,
    phenotype text,
    a1c_baseline numeric,
    weight_baseline numeric,
    egfr_baseline numeric,
    uacr_baseline numeric,
    a1c_followup numeric,
    weight_followup numeric,
    egfr_followup numeric,
    followup_days integer,
    a1c_delta numeric GENERATED ALWAYS AS ((a1c_followup - a1c_baseline)) STORED,
    weight_delta_kg numeric GENERATED ALWAYS AS ((weight_followup - weight_baseline)) STORED,
    doctor_name text,
    doctor_override boolean DEFAULT false,
    override_reason text,
    recommendation_shown boolean DEFAULT false,
    recommendation_accepted boolean,
    created_at timestamp with time zone DEFAULT now(),
    followup_recorded_at timestamp with time zone
);

ALTER TABLE ONLY public.treatment_events FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.treatment_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.treatment_events_id_seq OWNED BY public.treatment_events.id;

CREATE TABLE public.treatment_gaps (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    gap_type text NOT NULL,
    gap_code text NOT NULL,
    severity text NOT NULL,
    current_status text,
    recommendation text,
    evidence text,
    similar_patients integer DEFAULT 0,
    expected_improvement text,
    patient_message text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.treatment_gaps FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.treatment_gaps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.treatment_gaps_id_seq OWNED BY public.treatment_gaps.id;

CREATE VIEW public.v_active_meds WITH (security_invoker='on') AS
 SELECT patient_id,
    name,
    pharmacy_match,
    composition,
    dose,
    frequency,
    timing,
    for_diagnosis,
    started_date
   FROM public.medications
  WHERE (is_active = true)
  ORDER BY patient_id, name;

CREATE VIEW public.v_drug_usage WITH (security_invoker='on') AS
 SELECT dm.drug_class,
    dm.category,
    dm.generic_name,
    count(DISTINCT m.patient_id) AS patient_count,
    count(*) AS prescription_count
   FROM (public.medications m
     JOIN public.drug_master dm ON ((dm.id = m.drug_master_id)))
  WHERE (m.is_active = true)
  GROUP BY dm.drug_class, dm.category, dm.generic_name
  ORDER BY (count(DISTINCT m.patient_id)) DESC;

CREATE VIEW public.v_latest_hba1c WITH (security_invoker='on') AS
 SELECT DISTINCT ON (patient_id) patient_id,
    result AS hba1c,
    test_date,
    flag
   FROM public.lab_results
  WHERE (test_name = 'HbA1c'::text)
  ORDER BY patient_id, test_date DESC;

CREATE TABLE public.vitals (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    consultation_id integer,
    recorded_at timestamp with time zone DEFAULT now(),
    bp_sys numeric,
    bp_dia numeric,
    pulse numeric,
    temp numeric,
    spo2 numeric,
    weight numeric,
    height numeric,
    bmi numeric,
    rbs numeric,
    waist numeric,
    body_fat numeric,
    muscle_mass numeric,
    notes text,
    appointment_id integer,
    bp_standing_sys real,
    bp_standing_dia real,
    source text,
    meal_type text,
    giniflow_vitals_id uuid
);

ALTER TABLE ONLY public.vitals FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.vitals.giniflow_vitals_id IS 'The giniflow_vitals row this was promoted from. UNIQUE: one station reading, one clinical row.';

CREATE VIEW public.v_latest_vitals WITH (security_invoker='on') AS
 SELECT DISTINCT ON (patient_id) patient_id,
    bp_sys,
    bp_dia,
    pulse,
    spo2,
    weight,
    height,
    bmi,
    recorded_at
   FROM public.vitals
  ORDER BY patient_id, recorded_at DESC;

CREATE VIEW public.v_patient_drug_timeline WITH (security_invoker='on') AS
 SELECT m.patient_id,
    p.name AS patient_name,
    m.name AS drug_name,
    dm.drug_class,
    dm.category,
    m.dose,
    m.frequency,
    m.action,
    m.is_active,
    c.visit_date,
    m.for_diagnosis
   FROM (((public.medications m
     JOIN public.patients p ON ((p.id = m.patient_id)))
     JOIN public.consultations c ON ((c.id = m.consultation_id)))
     LEFT JOIN public.drug_master dm ON ((dm.id = m.drug_master_id)))
  ORDER BY m.patient_id, c.visit_date;

CREATE VIEW public.v_patient_summary WITH (security_invoker='on') AS
 SELECT id,
    name,
    phone,
    age,
    sex,
    file_no,
    abha_id,
    health_id,
    ( SELECT count(*) AS count
           FROM public.consultations c
          WHERE (c.patient_id = p.id)) AS visit_count,
    ( SELECT max(c.visit_date) AS max
           FROM public.consultations c
          WHERE (c.patient_id = p.id)) AS last_visit,
    ( SELECT string_agg(DISTINCT d.diagnosis_id, ','::text) AS string_agg
           FROM public.diagnoses d
          WHERE ((d.patient_id = p.id) AND d.is_active)) AS active_diagnoses
   FROM public.patients p;

CREATE TABLE public.visit_readiness (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    patient_id integer NOT NULL,
    generated_at timestamp with time zone DEFAULT now(),
    period_start date,
    period_end date,
    adherence_pct numeric,
    missed_meds jsonb,
    side_effects jsonb,
    vitals_summary jsonb,
    patient_questions jsonb,
    genie_summary text,
    is_current boolean DEFAULT true
);

ALTER TABLE ONLY public.visit_readiness FORCE ROW LEVEL SECURITY;

CREATE TABLE public.visit_symptoms (
    id integer NOT NULL,
    patient_id integer NOT NULL,
    symptom_id text NOT NULL,
    label text NOT NULL,
    since_date date,
    severity text DEFAULT 'Mild'::text,
    related_to text,
    status text DEFAULT 'Active'::text,
    appointment_id integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.visit_symptoms FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.visit_symptoms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.visit_symptoms_id_seq OWNED BY public.visit_symptoms.id;

CREATE SEQUENCE public.vitals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.vitals_id_seq OWNED BY public.vitals.id;

CREATE TABLE public.walkin_bookings (
    id integer NOT NULL,
    walkin_date date NOT NULL,
    time_slot text,
    file_no text,
    patient_name text,
    contact_number text,
    visit_type text DEFAULT 'New'::text,
    agent_name text,
    reason_for_booking text,
    standard_instruction text,
    last_visit_date date,
    misc text,
    whatsapp_message text,
    additional_whatsapp_message text,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.walkin_bookings FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.walkin_bookings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.walkin_bookings_id_seq OWNED BY public.walkin_bookings.id;

ALTER TABLE ONLY public.active_visits ALTER COLUMN id SET DEFAULT nextval('public.active_visits_id_seq'::regclass);

ALTER TABLE ONLY public.ai_batch_jobs ALTER COLUMN id SET DEFAULT nextval('public.ai_batch_jobs_id_seq'::regclass);

ALTER TABLE ONLY public.analytics_snapshots ALTER COLUMN id SET DEFAULT nextval('public.analytics_snapshots_id_seq'::regclass);

ALTER TABLE ONLY public.app_install_tracking ALTER COLUMN id SET DEFAULT nextval('public.app_install_tracking_id_seq'::regclass);

ALTER TABLE ONLY public.appointment_cancellations ALTER COLUMN id SET DEFAULT nextval('public.appointment_cancellations_id_seq'::regclass);

ALTER TABLE ONLY public.appointment_change_log ALTER COLUMN id SET DEFAULT nextval('public.appointment_change_log_id_seq'::regclass);

ALTER TABLE ONLY public.appointment_reassignments ALTER COLUMN id SET DEFAULT nextval('public.appointment_reassignments_id_seq'::regclass);

ALTER TABLE ONLY public.appointment_slots ALTER COLUMN id SET DEFAULT nextval('public.appointment_slots_id_seq'::regclass);

ALTER TABLE ONLY public.appointments ALTER COLUMN id SET DEFAULT nextval('public.appointments_id_seq'::regclass);

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);

ALTER TABLE ONLY public.auth_sessions ALTER COLUMN id SET DEFAULT nextval('public.auth_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.call_attempts ALTER COLUMN id SET DEFAULT nextval('public.call_attempts_id_seq'::regclass);

ALTER TABLE ONLY public.call_claim_sessions ALTER COLUMN id SET DEFAULT nextval('public.call_claim_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.cc_agents ALTER COLUMN id SET DEFAULT nextval('public.cc_agents_id_seq'::regclass);

ALTER TABLE ONLY public.cc_calling_log ALTER COLUMN id SET DEFAULT nextval('public.cc_calling_log_id_seq'::regclass);

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);

ALTER TABLE ONLY public.clinic_holidays ALTER COLUMN id SET DEFAULT nextval('public.clinic_holidays_id_seq'::regclass);

ALTER TABLE ONLY public.clinical_reasoning ALTER COLUMN id SET DEFAULT nextval('public.clinical_reasoning_id_seq'::regclass);

ALTER TABLE ONLY public.complications ALTER COLUMN id SET DEFAULT nextval('public.complications_id_seq'::regclass);

ALTER TABLE ONLY public.consultations ALTER COLUMN id SET DEFAULT nextval('public.consultations_id_seq'::regclass);

ALTER TABLE ONLY public.corporate_companies ALTER COLUMN id SET DEFAULT nextval('public.corporate_companies_id_seq'::regclass);

ALTER TABLE ONLY public.corporate_package_tests ALTER COLUMN id SET DEFAULT nextval('public.corporate_package_tests_id_seq'::regclass);

ALTER TABLE ONLY public.corporate_packages ALTER COLUMN id SET DEFAULT nextval('public.corporate_packages_id_seq'::regclass);

ALTER TABLE ONLY public.diabetes_champions ALTER COLUMN id SET DEFAULT nextval('public.diabetes_champions_id_seq'::regclass);

ALTER TABLE ONLY public.diagnoses ALTER COLUMN id SET DEFAULT nextval('public.diagnoses_id_seq'::regclass);

ALTER TABLE ONLY public.diet_plans ALTER COLUMN id SET DEFAULT nextval('public.diet_plans_id_seq'::regclass);

ALTER TABLE ONLY public.doctor_summaries ALTER COLUMN id SET DEFAULT nextval('public.doctor_summaries_id_seq'::regclass);

ALTER TABLE ONLY public.doctor_unavailability ALTER COLUMN id SET DEFAULT nextval('public.doctor_unavailability_id_seq'::regclass);

ALTER TABLE ONLY public.doctors ALTER COLUMN id SET DEFAULT nextval('public.doctors_id_seq'::regclass);

ALTER TABLE ONLY public.documents ALTER COLUMN id SET DEFAULT nextval('public.documents_id_seq'::regclass);

ALTER TABLE ONLY public.drug_master ALTER COLUMN id SET DEFAULT nextval('public.drug_master_id_seq'::regclass);

ALTER TABLE ONLY public.flow_staff ALTER COLUMN id SET DEFAULT nextval('public.flow_staff_id_seq'::regclass);

ALTER TABLE ONLY public.giniflow_interaction_acks ALTER COLUMN id SET DEFAULT nextval('public.giniflow_interaction_acks_id_seq'::regclass);

ALTER TABLE ONLY public.giniflow_interaction_rules ALTER COLUMN id SET DEFAULT nextval('public.giniflow_interaction_rules_id_seq'::regclass);

ALTER TABLE ONLY public.giniflow_lab_case_actions ALTER COLUMN id SET DEFAULT nextval('public.giniflow_lab_case_actions_id_seq'::regclass);

ALTER TABLE ONLY public.giniflow_lab_order_events ALTER COLUMN seq SET DEFAULT nextval('public.giniflow_lab_order_events_seq_seq'::regclass);

ALTER TABLE ONLY public.giniflow_referrals ALTER COLUMN ref_no SET DEFAULT nextval('public.giniflow_referrals_ref_no_seq'::regclass);

ALTER TABLE ONLY public.giniflow_triage_events ALTER COLUMN seq SET DEFAULT nextval('public.giniflow_triage_events_seq_seq'::regclass);

ALTER TABLE ONLY public.giniflow_visit_events ALTER COLUMN seq SET DEFAULT nextval('public.giniflow_visit_events_seq_seq'::regclass);

ALTER TABLE ONLY public.giniflow_vitals ALTER COLUMN seq SET DEFAULT nextval('public.giniflow_vitals_seq_seq'::regclass);

ALTER TABLE ONLY public.goals ALTER COLUMN id SET DEFAULT nextval('public.goals_id_seq'::regclass);

ALTER TABLE ONLY public.lab_cases ALTER COLUMN id SET DEFAULT nextval('public.lab_cases_id_seq'::regclass);

ALTER TABLE ONLY public.lab_results ALTER COLUMN id SET DEFAULT nextval('public.lab_results_id_seq'::regclass);

ALTER TABLE ONLY public.lab_test_ranges ALTER COLUMN id SET DEFAULT nextval('public.lab_test_ranges_id_seq'::regclass);

ALTER TABLE ONLY public.lab_test_requests ALTER COLUMN id SET DEFAULT nextval('public.lab_test_requests_id_seq'::regclass);

ALTER TABLE ONLY public.lead_campaigns ALTER COLUMN id SET DEFAULT nextval('public.lead_campaigns_id_seq'::regclass);

ALTER TABLE ONLY public.lead_events ALTER COLUMN id SET DEFAULT nextval('public.lead_events_id_seq'::regclass);

ALTER TABLE ONLY public.leads ALTER COLUMN id SET DEFAULT nextval('public.leads_id_seq'::regclass);

ALTER TABLE ONLY public.meal_logs ALTER COLUMN id SET DEFAULT nextval('public.meal_logs_id_seq'::regclass);

ALTER TABLE ONLY public.medications ALTER COLUMN id SET DEFAULT nextval('public.medications_id_seq'::regclass);

ALTER TABLE ONLY public.medicine_catalog ALTER COLUMN id SET DEFAULT nextval('public.medicine_catalog_id_seq'::regclass);

ALTER TABLE ONLY public.medicine_collections ALTER COLUMN id SET DEFAULT nextval('public.medicine_collections_id_seq'::regclass);

ALTER TABLE ONLY public.mhg_clinical_protocols ALTER COLUMN id SET DEFAULT nextval('public.mhg_clinical_protocols_id_seq'::regclass);

ALTER TABLE ONLY public.mhg_drug_formulary ALTER COLUMN id SET DEFAULT nextval('public.mhg_drug_formulary_id_seq'::regclass);

ALTER TABLE ONLY public.obt_call_status ALTER COLUMN id SET DEFAULT nextval('public.obt_call_status_id_seq'::regclass);

ALTER TABLE ONLY public.patient_activity_log ALTER COLUMN id SET DEFAULT nextval('public.patient_activity_log_id_seq'::regclass);

ALTER TABLE ONLY public.patient_block_log ALTER COLUMN id SET DEFAULT nextval('public.patient_block_log_id_seq'::regclass);

ALTER TABLE ONLY public.patient_briefs ALTER COLUMN id SET DEFAULT nextval('public.patient_briefs_id_seq'::regclass);

ALTER TABLE ONLY public.patient_conditions_genie ALTER COLUMN id SET DEFAULT nextval('public.patient_conditions_genie_id_seq'::regclass);

ALTER TABLE ONLY public.patient_drug_history ALTER COLUMN id SET DEFAULT nextval('public.patient_drug_history_id_seq'::regclass);

ALTER TABLE ONLY public.patient_meal_log ALTER COLUMN id SET DEFAULT nextval('public.patient_meal_log_id_seq'::regclass);

ALTER TABLE ONLY public.patient_med_log ALTER COLUMN id SET DEFAULT nextval('public.patient_med_log_id_seq'::regclass);

ALTER TABLE ONLY public.patient_medications_genie ALTER COLUMN id SET DEFAULT nextval('public.patient_medications_genie_id_seq'::regclass);

ALTER TABLE ONLY public.patient_special_alerts ALTER COLUMN id SET DEFAULT nextval('public.patient_special_alerts_id_seq'::regclass);

ALTER TABLE ONLY public.patient_summaries ALTER COLUMN id SET DEFAULT nextval('public.patient_summaries_id_seq'::regclass);

ALTER TABLE ONLY public.patient_symptom_log ALTER COLUMN id SET DEFAULT nextval('public.patient_symptom_log_id_seq'::regclass);

ALTER TABLE ONLY public.patient_vitals ALTER COLUMN id SET DEFAULT nextval('public.patient_vitals_id_seq'::regclass);

ALTER TABLE ONLY public.patient_vitals_log ALTER COLUMN id SET DEFAULT nextval('public.patient_vitals_log_id_seq'::regclass);

ALTER TABLE ONLY public.patients ALTER COLUMN id SET DEFAULT nextval('public.patients_id_seq'::regclass);

ALTER TABLE ONLY public.referrals ALTER COLUMN id SET DEFAULT nextval('public.referrals_id_seq'::regclass);

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.rx_review_feedback ALTER COLUMN id SET DEFAULT nextval('public.rx_review_feedback_id_seq'::regclass);

ALTER TABLE ONLY public.scheme_cap_overrides ALTER COLUMN id SET DEFAULT nextval('public.scheme_cap_overrides_id_seq'::regclass);

ALTER TABLE ONLY public.slot_catalog ALTER COLUMN id SET DEFAULT nextval('public.slot_catalog_id_seq'::regclass);

ALTER TABLE ONLY public.station_tracking ALTER COLUMN id SET DEFAULT nextval('public.station_tracking_id_seq'::regclass);

ALTER TABLE ONLY public.treatment_events ALTER COLUMN id SET DEFAULT nextval('public.treatment_events_id_seq'::regclass);

ALTER TABLE ONLY public.treatment_gaps ALTER COLUMN id SET DEFAULT nextval('public.treatment_gaps_id_seq'::regclass);

ALTER TABLE ONLY public.visit_symptoms ALTER COLUMN id SET DEFAULT nextval('public.visit_symptoms_id_seq'::regclass);

ALTER TABLE ONLY public.vitals ALTER COLUMN id SET DEFAULT nextval('public.vitals_id_seq'::regclass);

ALTER TABLE ONLY public.walkin_bookings ALTER COLUMN id SET DEFAULT nextval('public.walkin_bookings_id_seq'::regclass);

ALTER TABLE ONLY public.active_visits
    ADD CONSTRAINT active_visits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_batch_jobs
    ADD CONSTRAINT ai_batch_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alert_channel
    ADD CONSTRAINT alert_channel_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.alert_channel
    ADD CONSTRAINT alert_channel_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY public.analytics_snapshot_sections
    ADD CONSTRAINT analytics_snapshot_sections_pkey PRIMARY KEY (snapshot_id, section_id);

ALTER TABLE ONLY public.analytics_snapshots
    ADD CONSTRAINT analytics_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_install_tracking
    ADD CONSTRAINT app_install_tracking_file_no_key UNIQUE (file_no);

ALTER TABLE ONLY public.app_install_tracking
    ADD CONSTRAINT app_install_tracking_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_kv
    ADD CONSTRAINT app_kv_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.appointment_cancellations
    ADD CONSTRAINT appointment_cancellations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.appointment_change_log
    ADD CONSTRAINT appointment_change_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.appointment_reassignments
    ADD CONSTRAINT appointment_reassignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.appointment_slots
    ADD CONSTRAINT appointment_slots_doctor_name_slot_date_time_slot_key UNIQUE (doctor_name, slot_date, time_slot);

ALTER TABLE ONLY public.appointment_slots
    ADD CONSTRAINT appointment_slots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_healthray_id_key UNIQUE (healthray_id);

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.call_attempts
    ADD CONSTRAINT call_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.call_claim_sessions
    ADD CONSTRAINT call_claim_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.care_circle
    ADD CONSTRAINT care_circle_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cc_agents
    ADD CONSTRAINT cc_agents_name_key UNIQUE (name);

ALTER TABLE ONLY public.cc_agents
    ADD CONSTRAINT cc_agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cc_calling_log
    ADD CONSTRAINT cc_calling_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clinic_holidays
    ADD CONSTRAINT clinic_holidays_holiday_date_key UNIQUE (holiday_date);

ALTER TABLE ONLY public.clinic_holidays
    ADD CONSTRAINT clinic_holidays_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clinical_reasoning
    ADD CONSTRAINT clinical_reasoning_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.complications
    ADD CONSTRAINT complications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.consultation_test_status
    ADD CONSTRAINT consultation_test_status_pkey PRIMARY KEY (consultation_id, test_name);

ALTER TABLE ONLY public.consultations
    ADD CONSTRAINT consultations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_patient_id_kind_doctor_id_key UNIQUE (patient_id, kind, doctor_id);

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.corporate_companies
    ADD CONSTRAINT corporate_companies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.corporate_companies
    ADD CONSTRAINT corporate_companies_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.corporate_package_tests
    ADD CONSTRAINT corporate_package_tests_package_name_uniq UNIQUE (package_id, test_name);

ALTER TABLE ONLY public.corporate_package_tests
    ADD CONSTRAINT corporate_package_tests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.corporate_packages
    ADD CONSTRAINT corporate_packages_company_name_uniq UNIQUE (company_id, name);

ALTER TABLE ONLY public.corporate_packages
    ADD CONSTRAINT corporate_packages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diabetes_champions
    ADD CONSTRAINT diabetes_champions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diagnoses
    ADD CONSTRAINT diagnoses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.diet_plans
    ADD CONSTRAINT diet_plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctor_profile
    ADD CONSTRAINT doctor_profile_pkey PRIMARY KEY (doctor_id);

ALTER TABLE ONLY public.doctor_summaries
    ADD CONSTRAINT doctor_summaries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctor_unavailability
    ADD CONSTRAINT doctor_unavailability_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drug_master
    ADD CONSTRAINT drug_master_generic_name_key UNIQUE (generic_name);

ALTER TABLE ONLY public.drug_master
    ADD CONSTRAINT drug_master_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_events
    ADD CONSTRAINT flow_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_staff
    ADD CONSTRAINT flow_staff_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_step_catalog
    ADD CONSTRAINT flow_step_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_step_templates
    ADD CONSTRAINT flow_step_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_step_templates
    ADD CONSTRAINT flow_step_templates_visit_type_id_step_order_key UNIQUE (visit_type_id, step_order);

ALTER TABLE ONLY public.flow_visit_steps
    ADD CONSTRAINT flow_visit_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_visit_steps
    ADD CONSTRAINT flow_visit_steps_visit_id_step_order_key UNIQUE (visit_id, step_order) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.flow_visit_types
    ADD CONSTRAINT flow_visit_types_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_visit_token_key UNIQUE (visit_token);

ALTER TABLE ONLY public.flow_wait_daily
    ADD CONSTRAINT flow_wait_daily_pkey PRIMARY KEY (date, visit_type_id);

ALTER TABLE ONLY public.flow_wait_station_daily
    ADD CONSTRAINT flow_wait_station_daily_pkey PRIMARY KEY (date, station);

ALTER TABLE ONLY public.giniflow_care_plans
    ADD CONSTRAINT giniflow_care_plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_care_plans
    ADD CONSTRAINT giniflow_care_plans_visit_id_key UNIQUE (visit_id);

ALTER TABLE ONLY public.giniflow_floor_settings
    ADD CONSTRAINT giniflow_floor_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.giniflow_interaction_acks
    ADD CONSTRAINT giniflow_interaction_acks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_interaction_acks
    ADD CONSTRAINT giniflow_interaction_acks_visit_id_rule_key_key UNIQUE (visit_id, rule_key);

ALTER TABLE ONLY public.giniflow_interaction_rules
    ADD CONSTRAINT giniflow_interaction_rules_class_a_class_b_key UNIQUE (class_a, class_b);

ALTER TABLE ONLY public.giniflow_interaction_rules
    ADD CONSTRAINT giniflow_interaction_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_lab_case_actions
    ADD CONSTRAINT giniflow_lab_case_actions_case_no_action_key UNIQUE (case_no, action);

ALTER TABLE ONLY public.giniflow_lab_case_actions
    ADD CONSTRAINT giniflow_lab_case_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_lab_order_events
    ADD CONSTRAINT giniflow_lab_order_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_lab_order_tests
    ADD CONSTRAINT giniflow_lab_order_tests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_lab_orders
    ADD CONSTRAINT giniflow_lab_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_patient_bills
    ADD CONSTRAINT giniflow_patient_bills_pkey PRIMARY KEY (patient_id, bill_date);

ALTER TABLE ONLY public.giniflow_referrals
    ADD CONSTRAINT giniflow_referrals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_rx_items
    ADD CONSTRAINT giniflow_rx_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_rx_proposals
    ADD CONSTRAINT giniflow_rx_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_sd_notes
    ADD CONSTRAINT giniflow_sd_notes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_sd_notes
    ADD CONSTRAINT giniflow_sd_notes_visit_id_key UNIQUE (visit_id);

ALTER TABLE ONLY public.giniflow_sla_config
    ADD CONSTRAINT giniflow_sla_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_sla_config
    ADD CONSTRAINT giniflow_sla_config_station_key UNIQUE (station);

ALTER TABLE ONLY public.giniflow_test_catalog
    ADD CONSTRAINT giniflow_test_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_test_catalog
    ADD CONSTRAINT giniflow_test_catalog_test_name_key UNIQUE (test_name);

ALTER TABLE ONLY public.giniflow_test_panels
    ADD CONSTRAINT giniflow_test_panels_panel_key_key UNIQUE (panel_key);

ALTER TABLE ONLY public.giniflow_test_panels
    ADD CONSTRAINT giniflow_test_panels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_triage_events
    ADD CONSTRAINT giniflow_triage_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_visit_events
    ADD CONSTRAINT giniflow_visit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_visit_steps
    ADD CONSTRAINT giniflow_visit_steps_order UNIQUE (visit_id, step_order) DEFERRABLE;

ALTER TABLE ONLY public.giniflow_visit_steps
    ADD CONSTRAINT giniflow_visit_steps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_one_per_patient_day UNIQUE (patient_id, visit_date);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.giniflow_vitals
    ADD CONSTRAINT giniflow_vitals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.glp1_cohort
    ADD CONSTRAINT glp1_cohort_pkey PRIMARY KEY (patient_id);

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lab_cases
    ADD CONSTRAINT lab_cases_case_no_key UNIQUE (case_no);

ALTER TABLE ONLY public.lab_cases
    ADD CONSTRAINT lab_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lab_report_catalog
    ADD CONSTRAINT lab_report_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lab_report_tests
    ADD CONSTRAINT lab_report_tests_pkey PRIMARY KEY (report_id, test_id);

ALTER TABLE ONLY public.lab_results_appt_unlink_backup_20260430
    ADD CONSTRAINT lab_results_appt_unlink_backup_20260430_pkey PRIMARY KEY (lab_id);

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lab_test_catalog
    ADD CONSTRAINT lab_test_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lab_test_mapping
    ADD CONSTRAINT lab_test_mapping_pkey PRIMARY KEY (raw_name);

ALTER TABLE ONLY public.lab_test_ranges
    ADD CONSTRAINT lab_test_ranges_healthray_ref_id_key UNIQUE (healthray_ref_id);

ALTER TABLE ONLY public.lab_test_ranges
    ADD CONSTRAINT lab_test_ranges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lab_test_requests
    ADD CONSTRAINT lab_test_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_campaigns
    ADD CONSTRAINT lead_campaigns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_events
    ADD CONSTRAINT lead_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.meal_logs
    ADD CONSTRAINT meal_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medication_adherence
    ADD CONSTRAINT medication_adherence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medication_dose_change_requests
    ADD CONSTRAINT medication_dose_change_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medication_refill_request_items
    ADD CONSTRAINT medication_refill_request_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medication_refill_requests
    ADD CONSTRAINT medication_refill_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medications
    ADD CONSTRAINT medications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medicine_catalog
    ADD CONSTRAINT medicine_catalog_name_key UNIQUE (name);

ALTER TABLE ONLY public.medicine_catalog
    ADD CONSTRAINT medicine_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.medicine_collections
    ADD CONSTRAINT medicine_collections_medication_id_collected_date_key UNIQUE (medication_id, collected_date);

ALTER TABLE ONLY public.medicine_collections
    ADD CONSTRAINT medicine_collections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mhg_clinical_protocols
    ADD CONSTRAINT mhg_clinical_protocols_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mhg_clinical_protocols
    ADD CONSTRAINT mhg_clinical_protocols_protocol_id_key UNIQUE (protocol_id);

ALTER TABLE ONLY public.mhg_drug_formulary
    ADD CONSTRAINT mhg_drug_formulary_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mhg_vitals
    ADD CONSTRAINT mhg_vitals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mhg_vitals
    ADD CONSTRAINT mhg_vitals_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY public.obt_call_status
    ADD CONSTRAINT obt_call_status_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_activity_log
    ADD CONSTRAINT patient_activity_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_block_log
    ADD CONSTRAINT patient_block_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_briefs
    ADD CONSTRAINT patient_briefs_patient_id_brief_type_key UNIQUE (patient_id, brief_type);

ALTER TABLE ONLY public.patient_briefs
    ADD CONSTRAINT patient_briefs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_conditions_genie
    ADD CONSTRAINT patient_conditions_genie_genie_id_key UNIQUE (genie_id);

ALTER TABLE ONLY public.patient_conditions_genie
    ADD CONSTRAINT patient_conditions_genie_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_drug_history
    ADD CONSTRAINT patient_drug_history_patient_id_drug_class_brand_key UNIQUE (patient_id, drug_class, brand);

ALTER TABLE ONLY public.patient_drug_history
    ADD CONSTRAINT patient_drug_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_health_model
    ADD CONSTRAINT patient_health_model_pkey PRIMARY KEY (patient_id);

ALTER TABLE ONLY public.patient_insights
    ADD CONSTRAINT patient_insights_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_meal_log
    ADD CONSTRAINT patient_meal_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_med_log
    ADD CONSTRAINT patient_med_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_med_streak
    ADD CONSTRAINT patient_med_streak_pkey PRIMARY KEY (patient_id);

ALTER TABLE ONLY public.patient_medications_genie
    ADD CONSTRAINT patient_medications_genie_genie_id_key UNIQUE (genie_id);

ALTER TABLE ONLY public.patient_medications_genie
    ADD CONSTRAINT patient_medications_genie_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_messages
    ADD CONSTRAINT patient_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_metabolic_profile
    ADD CONSTRAINT patient_metabolic_profile_pkey PRIMARY KEY (patient_id);

ALTER TABLE ONLY public.patient_push_tokens
    ADD CONSTRAINT patient_push_tokens_patient_id_fcm_token_key UNIQUE (patient_id, fcm_token);

ALTER TABLE ONLY public.patient_push_tokens
    ADD CONSTRAINT patient_push_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_reported_side_effects
    ADD CONSTRAINT patient_reported_side_effects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_schemes
    ADD CONSTRAINT patient_schemes_pkey PRIMARY KEY (code);

ALTER TABLE ONLY public.patient_special_alerts
    ADD CONSTRAINT patient_special_alerts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_summaries
    ADD CONSTRAINT patient_summaries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_symptom_log
    ADD CONSTRAINT patient_symptom_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_treatment_history
    ADD CONSTRAINT patient_treatment_history_pkey PRIMARY KEY (patient_id);

ALTER TABLE ONLY public.patient_vitals_log
    ADD CONSTRAINT patient_vitals_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patient_vitals
    ADD CONSTRAINT patient_vitals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_file_no_unique UNIQUE (file_no);

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pharmacy_inventory
    ADD CONSTRAINT pharmacy_inventory_medicine_name_key UNIQUE (medicine_name);

ALTER TABLE ONLY public.pharmacy_inventory
    ADD CONSTRAINT pharmacy_inventory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.rx_review_feedback
    ADD CONSTRAINT rx_review_feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.scheme_cap_overrides
    ADD CONSTRAINT scheme_cap_overrides_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.scheme_medicine_prices
    ADD CONSTRAINT scheme_medicine_prices_pkey PRIMARY KEY (scheme_code, medicine_name);

ALTER TABLE ONLY public.scheme_test_prices
    ADD CONSTRAINT scheme_test_prices_pkey PRIMARY KEY (scheme_code, test_name);

ALTER TABLE ONLY public.slot_catalog
    ADD CONSTRAINT slot_catalog_label_key UNIQUE (label);

ALTER TABLE ONLY public.slot_catalog
    ADD CONSTRAINT slot_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.station_tracking
    ADD CONSTRAINT station_tracking_appt_unique UNIQUE (appointment_id);

ALTER TABLE ONLY public.station_tracking
    ADD CONSTRAINT station_tracking_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.symptom_logs
    ADD CONSTRAINT symptom_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.treatment_gaps
    ADD CONSTRAINT treatment_gaps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.visit_readiness
    ADD CONSTRAINT visit_readiness_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.visit_symptoms
    ADD CONSTRAINT visit_symptoms_patient_id_symptom_id_key UNIQUE (patient_id, symptom_id);

ALTER TABLE ONLY public.visit_symptoms
    ADD CONSTRAINT visit_symptoms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vitals
    ADD CONSTRAINT vitals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.walkin_bookings
    ADD CONSTRAINT walkin_bookings_pkey PRIMARY KEY (id);

CREATE INDEX ai_batch_jobs_batch_id_idx ON public.ai_batch_jobs USING btree (batch_id) WHERE (batch_id IS NOT NULL);

CREATE INDEX ai_batch_jobs_dedup_idx ON public.ai_batch_jobs USING btree (((context ->> 'dedup_key'::text))) WHERE (status = ANY (ARRAY['pending'::text, 'submitted'::text]));

CREATE INDEX ai_batch_jobs_status_type_idx ON public.ai_batch_jobs USING btree (status, job_type);

CREATE INDEX alert_channel_direction_idx ON public.alert_channel USING btree (direction);

CREATE INDEX alert_channel_patient_idx ON public.alert_channel USING btree (patient_id);

CREATE INDEX alert_channel_unsynced_idx ON public.alert_channel USING btree (synced_to_mhg) WHERE (synced_to_mhg IS NULL);

CREATE INDEX consultation_test_status_patient_idx ON public.consultation_test_status USING btree (patient_id);

CREATE UNIQUE INDEX conversations_unique_doctor ON public.conversations USING btree (patient_id, kind, doctor_id) WHERE (doctor_id IS NOT NULL);

CREATE UNIQUE INDEX conversations_unique_team ON public.conversations USING btree (patient_id, kind) WHERE (doctor_id IS NULL);

CREATE INDEX giniflow_interaction_acks_visit_idx ON public.giniflow_interaction_acks USING btree (visit_id);

CREATE INDEX idx_active_visits_doctor ON public.active_visits USING btree (doctor_id);

CREATE INDEX idx_active_visits_doctor_status ON public.active_visits USING btree (doctor_id, status) WHERE (status = 'in-progress'::text);

CREATE INDEX idx_agent_conversations_patient ON public.agent_conversations USING btree (patient_id, last_message_at DESC);

CREATE INDEX idx_alerts_file_no ON public.patient_special_alerts USING btree (file_no);

CREATE INDEX idx_analytics_snapshots_as_of ON public.analytics_snapshots USING btree (as_of DESC, id DESC) WHERE (status = 'ok'::text);

CREATE INDEX idx_app_install_file ON public.app_install_tracking USING btree (file_no);

CREATE INDEX idx_appointments_alt_phone ON public.appointments USING gin (alt_phone);

CREATE INDEX idx_appointments_calling_since ON public.appointments USING btree (calling_since) WHERE (calling_since IS NOT NULL);

CREATE INDEX idx_appointments_category_date ON public.appointments USING btree (appointment_date, patient_category) WHERE (patient_category IS NOT NULL);

CREATE INDEX idx_appointments_corporate_date ON public.appointments USING btree (appointment_date, corporate_company_id) WHERE (corporate_company_id IS NOT NULL);

CREATE INDEX idx_appointments_date ON public.appointments USING btree (appointment_date);

CREATE INDEX idx_appointments_doctor ON public.appointments USING btree (doctor_name);

CREATE INDEX idx_appointments_family_member ON public.appointments USING btree (family_member_id);

CREATE INDEX idx_appointments_patient ON public.appointments USING btree (patient_id);

CREATE INDEX idx_appointments_patient_date ON public.appointments USING btree (patient_id, appointment_date DESC);

CREATE INDEX idx_appointments_pre_visit_compliance_at ON public.appointments USING btree (pre_visit_compliance_at) WHERE (pre_visit_compliance_at IS NOT NULL);

CREATE INDEX idx_appointments_pre_visit_symptoms_at ON public.appointments USING btree (pre_visit_symptoms_at) WHERE (pre_visit_symptoms_at IS NOT NULL);

CREATE INDEX idx_appt_alt_phone_text_trgm ON public.appointments USING gin (public.alt_phone_text(alt_phone) public.gin_trgm_ops);

CREATE INDEX idx_appt_backfill_pending ON public.appointments USING btree (appointment_date) WHERE ((opd_backfilled_at IS NULL) AND (healthray_clinical_notes IS NOT NULL));

CREATE INDEX idx_appt_call_status ON public.appointments USING btree (call_status);

CREATE INDEX idx_appt_change_appt ON public.appointment_change_log USING btree (appointment_id);

CREATE INDEX idx_appt_doctor_id ON public.appointments USING btree (doctor_id);

CREATE INDEX idx_appt_file_no_date ON public.appointments USING btree (file_no, appointment_date DESC) WHERE (file_no IS NOT NULL);

CREATE INDEX idx_appt_file_no_trgm ON public.appointments USING gin (file_no public.gin_trgm_ops);

CREATE UNIQUE INDEX idx_appt_healthray ON public.appointments USING btree (healthray_id) WHERE (healthray_id IS NOT NULL);

CREATE UNIQUE INDEX idx_appt_patient_day_slot_doc_status ON public.appointments USING btree (file_no, appointment_date, time_slot, doctor_name, status) WHERE ((file_no IS NOT NULL) AND (appointment_date IS NOT NULL) AND (time_slot IS NOT NULL) AND (doctor_name IS NOT NULL) AND (status IS NOT NULL));

CREATE INDEX idx_appt_patient_name_trgm ON public.appointments USING gin (patient_name public.gin_trgm_ops);

CREATE INDEX idx_appt_phone_trgm ON public.appointments USING gin (phone public.gin_trgm_ops);

CREATE INDEX idx_appt_preferred_date ON public.appointments USING btree (preferred_date) WHERE (preferred_date IS NOT NULL);

CREATE INDEX idx_auth_sessions_expires ON public.auth_sessions USING btree (expires_at);

CREATE INDEX idx_auth_sessions_token ON public.auth_sessions USING btree (token);

CREATE INDEX idx_call_attempts_appt ON public.call_attempts USING btree (appointment_id);

CREATE INDEX idx_call_attempts_patient ON public.call_attempts USING btree (patient_id);

CREATE INDEX idx_call_attempts_when ON public.call_attempts USING btree (called_at);

CREATE INDEX idx_call_claim_sessions_appt ON public.call_claim_sessions USING btree (appointment_id, started_at DESC);

CREATE INDEX idx_call_claim_sessions_who ON public.call_claim_sessions USING btree (called_by_id, started_at DESC);

CREATE INDEX idx_cancel_appt_date ON public.appointment_cancellations USING btree (appointment_date);

CREATE INDEX idx_cancel_file_no ON public.appointment_cancellations USING btree (file_no);

CREATE INDEX idx_cc_log_call_type ON public.cc_calling_log USING btree (call_type);

CREATE INDEX idx_cc_log_cc_assigned ON public.cc_calling_log USING btree (cc_assigned);

CREATE INDEX idx_cc_log_file_no ON public.cc_calling_log USING btree (file_no);

CREATE INDEX idx_cc_log_visit_date ON public.cc_calling_log USING btree (visit_date);

CREATE INDEX idx_champions_file_no ON public.diabetes_champions USING btree (file_no);

CREATE INDEX idx_chat_messages_patient_date ON public.chat_messages USING btree (patient_id, chat_date, created_at);

CREATE INDEX idx_clinic_holidays_date ON public.clinic_holidays USING btree (holiday_date);

CREATE INDEX idx_complications_patient ON public.complications USING btree (patient_id);

CREATE INDEX idx_consultations_con ON public.consultations USING btree (con_name);

CREATE INDEX idx_consultations_date ON public.consultations USING btree (visit_date);

CREATE INDEX idx_consultations_parsed ON public.consultations USING btree (parsed_at);

CREATE INDEX idx_consultations_patient ON public.consultations USING btree (patient_id);

CREATE INDEX idx_consultations_patient_date ON public.consultations USING btree (patient_id, visit_date DESC);

CREATE INDEX idx_conversations_kind_doctor ON public.conversations USING btree (kind, doctor_id);

CREATE INDEX idx_conversations_patient ON public.conversations USING btree (patient_id);

CREATE INDEX idx_corporate_package_tests_package ON public.corporate_package_tests USING btree (package_id, sort_order);

CREATE INDEX idx_corporate_packages_company ON public.corporate_packages USING btree (company_id) WHERE is_active;

CREATE INDEX idx_cr_condition ON public.clinical_reasoning USING btree (primary_condition);

CREATE INDEX idx_cr_consultation ON public.clinical_reasoning USING btree (consultation_id);

CREATE INDEX idx_cr_created ON public.clinical_reasoning USING btree (created_at);

CREATE INDEX idx_cr_doctor ON public.clinical_reasoning USING btree (doctor_id);

CREATE INDEX idx_dcr_med ON public.medication_dose_change_requests USING btree (medication_id);

CREATE UNIQUE INDEX idx_dcr_one_pending_per_med ON public.medication_dose_change_requests USING btree (patient_id, medication_id) WHERE (status = 'pending'::text);

CREATE INDEX idx_dcr_patient ON public.medication_dose_change_requests USING btree (patient_id, status, requested_at DESC);

CREATE INDEX idx_dcr_status ON public.medication_dose_change_requests USING btree (status, requested_at DESC);

CREATE INDEX idx_diagnoses_active ON public.diagnoses USING btree (patient_id, is_active);

CREATE INDEX idx_diagnoses_category ON public.diagnoses USING btree (patient_id, category);

CREATE INDEX idx_diagnoses_patient ON public.diagnoses USING btree (patient_id);

CREATE INDEX idx_diagnoses_patient_active ON public.diagnoses USING btree (patient_id, is_active);

CREATE UNIQUE INDEX idx_doc_healthray ON public.doctors USING btree (healthray_id) WHERE (healthray_id IS NOT NULL);

CREATE INDEX idx_doctor_summaries_patient ON public.doctor_summaries USING btree (patient_id, version DESC);

CREATE INDEX idx_documents_patient ON public.documents USING btree (patient_id);

CREATE INDEX idx_documents_uploaded_by_patient ON public.documents USING btree (patient_id) WHERE (uploaded_by_patient = true);

CREATE INDEX idx_drug_history_contraindicated ON public.patient_drug_history USING btree (patient_id, contraindicated);

CREATE INDEX idx_drug_history_patient ON public.patient_drug_history USING btree (patient_id);

CREATE INDEX idx_drug_master_category ON public.drug_master USING btree (category);

CREATE INDEX idx_drug_master_class ON public.drug_master USING btree (drug_class);

CREATE INDEX idx_fe_type ON public.flow_events USING btree (event_type);

CREATE INDEX idx_fe_visit ON public.flow_events USING btree (visit_id);

CREATE INDEX idx_flow_visits_appointment ON public.flow_visits USING btree (appointment_id);

CREATE INDEX idx_flow_visits_date ON public.flow_visits USING btree (visit_date);

CREATE INDEX idx_flow_visits_patient ON public.flow_visits USING btree (patient_id);

CREATE INDEX idx_flow_visits_patient_db_id ON public.flow_visits USING btree (patient_db_id);

CREATE INDEX idx_flow_visits_status ON public.flow_visits USING btree (status);

CREATE INDEX idx_flow_visits_token ON public.flow_visits USING btree (visit_token);

CREATE INDEX idx_flow_visits_token_number ON public.flow_visits USING btree (visit_date, token_number) WHERE (token_number IS NOT NULL);

CREATE INDEX idx_flow_wait_daily_date ON public.flow_wait_daily USING btree (date DESC);

CREATE INDEX idx_flow_wait_station_daily_date ON public.flow_wait_station_daily USING btree (date DESC);

CREATE INDEX idx_formulary_drug_class ON public.mhg_drug_formulary USING btree (drug_class);

CREATE INDEX idx_formulary_molecule ON public.mhg_drug_formulary USING btree (molecule);

CREATE INDEX idx_fvs_assigned ON public.flow_visit_steps USING btree (assigned_role, status);

CREATE INDEX idx_fvs_background ON public.flow_visit_steps USING btree (visit_id) WHERE is_background;

CREATE INDEX idx_fvs_status ON public.flow_visit_steps USING btree (status);

CREATE INDEX idx_fvs_visit ON public.flow_visit_steps USING btree (visit_id);

CREATE INDEX idx_giniflow_events_visit_time ON public.giniflow_visit_events USING btree (visit_id, occurred_at);

CREATE INDEX idx_giniflow_lab_case_actions_case ON public.giniflow_lab_case_actions USING btree (case_no);

CREATE INDEX idx_giniflow_lab_events_order ON public.giniflow_lab_order_events USING btree (lab_order_id, occurred_at);

CREATE INDEX idx_giniflow_lab_order_events_seq ON public.giniflow_lab_order_events USING btree (seq);

CREATE INDEX idx_giniflow_lab_order_tests_order ON public.giniflow_lab_order_tests USING btree (lab_order_id);

CREATE INDEX idx_giniflow_lab_orders_kind ON public.giniflow_lab_orders USING btree (kind);

CREATE INDEX idx_giniflow_lab_orders_visit ON public.giniflow_lab_orders USING btree (visit_id);

CREATE INDEX idx_giniflow_referrals_created ON public.giniflow_referrals USING btree (created_at DESC);

CREATE INDEX idx_giniflow_referrals_visit ON public.giniflow_referrals USING btree (visit_id);

CREATE UNIQUE INDEX idx_giniflow_referrals_visit_specialty ON public.giniflow_referrals USING btree (visit_id, specialty);

CREATE INDEX idx_giniflow_rx_items_pending ON public.giniflow_rx_items USING btree (visit_id) WHERE (approval_status = 'pending'::text);

CREATE INDEX idx_giniflow_rx_items_visit ON public.giniflow_rx_items USING btree (visit_id, sort_order);

CREATE INDEX idx_giniflow_rx_proposals_visit ON public.giniflow_rx_proposals USING btree (visit_id, created_at);

CREATE INDEX idx_giniflow_triage_events_seq ON public.giniflow_triage_events USING btree (seq);

CREATE INDEX idx_giniflow_triage_events_visit ON public.giniflow_triage_events USING btree (visit_id, occurred_at);

CREATE INDEX idx_giniflow_visit_events_seq ON public.giniflow_visit_events USING btree (seq);

CREATE INDEX idx_giniflow_visit_steps_visit ON public.giniflow_visit_steps USING btree (visit_id, step_order);

CREATE INDEX idx_giniflow_visits_behind ON public.giniflow_visits USING btree (visit_date, behind_station) WHERE (behind_station IS NOT NULL);

CREATE INDEX idx_giniflow_visits_category_source ON public.giniflow_visits USING btree (visit_date, category_source);

CREATE INDEX idx_giniflow_visits_day_status ON public.giniflow_visits USING btree (visit_date, current_status);

CREATE INDEX idx_giniflow_visits_demo ON public.giniflow_visits USING btree (visit_date) WHERE is_demo;

CREATE INDEX idx_giniflow_visits_machine_scan ON public.giniflow_visits USING btree (visit_date, machine_scan_at NULLS FIRST);

CREATE INDEX idx_giniflow_visits_merged_into ON public.giniflow_visits USING btree (merged_into_visit_id) WHERE (merged_into_visit_id IS NOT NULL);

CREATE INDEX idx_giniflow_visits_patient ON public.giniflow_visits USING btree (patient_id);

CREATE INDEX idx_giniflow_visits_paused ON public.giniflow_visits USING btree (visit_date) WHERE (paused_at IS NOT NULL);

CREATE UNIQUE INDEX idx_giniflow_visits_token ON public.giniflow_visits USING btree (visit_token) WHERE (visit_token IS NOT NULL);

CREATE INDEX idx_giniflow_vitals_patient ON public.giniflow_vitals USING btree (patient_id, recorded_at DESC);

CREATE INDEX idx_giniflow_vitals_seq ON public.giniflow_vitals USING btree (seq);

CREATE INDEX idx_giniflow_vitals_visit ON public.giniflow_vitals USING btree (visit_id, recorded_at DESC);

CREATE UNIQUE INDEX idx_goals_consultation_marker ON public.goals USING btree (consultation_id, marker) WHERE (consultation_id IS NOT NULL);

CREATE INDEX idx_goals_patient ON public.goals USING btree (patient_id);

CREATE INDEX idx_lab_canonical ON public.lab_results USING btree (patient_id, canonical_name);

CREATE INDEX idx_lab_cases_appt ON public.lab_cases USING btree (appointment_id);

CREATE INDEX idx_lab_cases_date ON public.lab_cases USING btree (case_date);

CREATE INDEX idx_lab_cases_patient ON public.lab_cases USING btree (patient_id);

CREATE INDEX idx_lab_cases_pdf_retry ON public.lab_cases USING btree (pdf_next_attempt_at) WHERE ((pdf_storage_path IS NULL) AND (COALESCE(pdf_unavailable, false) = false));

CREATE INDEX idx_lab_cases_pending ON public.lab_cases USING btree (results_synced) WHERE (results_synced = false);

CREATE INDEX idx_lab_report_tests_test ON public.lab_report_tests USING btree (test_id);

CREATE UNIQUE INDEX idx_lab_results_genie_id ON public.lab_results USING btree (genie_id);

CREATE INDEX idx_lab_results_lab_case_no ON public.lab_results USING btree (lab_case_no) WHERE (lab_case_no IS NOT NULL);

CREATE INDEX idx_lab_results_order ON public.lab_results USING btree (lab_order_id) WHERE (lab_order_id IS NOT NULL);

CREATE INDEX idx_lab_results_panel_name_trgm ON public.lab_results USING gin (panel_name public.gin_trgm_ops);

CREATE INDEX idx_lab_results_patient_canonical_date ON public.lab_results USING btree (patient_id, canonical_name, test_date DESC);

CREATE INDEX idx_lab_results_patient_date ON public.lab_results USING btree (patient_id, test_date DESC);

CREATE INDEX idx_lab_results_test_name_trgm ON public.lab_results USING gin (test_name public.gin_trgm_ops);

CREATE INDEX idx_lab_test_catalog_parent ON public.lab_test_catalog USING btree (parent_test_id);

CREATE INDEX idx_lab_test_ranges_test ON public.lab_test_ranges USING btree (test_id);

CREATE INDEX idx_labreq_patient ON public.lab_test_requests USING btree (patient_id, created_at DESC);

CREATE INDEX idx_labreq_status ON public.lab_test_requests USING btree (status, created_at DESC);

CREATE INDEX idx_labs_date ON public.lab_results USING btree (test_date);

CREATE INDEX idx_labs_patient ON public.lab_results USING btree (patient_id);

CREATE INDEX idx_labs_test ON public.lab_results USING btree (patient_id, test_name, test_date);

CREATE INDEX idx_lead_events_lead ON public.lead_events USING btree (lead_id, at DESC);

CREATE INDEX idx_leads_created ON public.leads USING btree (created_at DESC);

CREATE INDEX idx_leads_owner ON public.leads USING btree (owner_doctor_id);

CREATE INDEX idx_leads_phone10 ON public.leads USING btree ("right"(regexp_replace(phone, '\D'::text, ''::text, 'g'::text), 10)) WHERE ((phone IS NOT NULL) AND (phone <> ''::text));

CREATE INDEX idx_leads_source ON public.leads USING btree (source);

CREATE INDEX idx_leads_status_next_action ON public.leads USING btree (status, next_action_at);

CREATE INDEX idx_meal_logs_patient_logged ON public.meal_logs USING btree (patient_id, logged_at DESC);

CREATE UNIQUE INDEX idx_meal_logs_patient_source ON public.meal_logs USING btree (patient_id, source_id);

CREATE INDEX idx_medcoll_appt ON public.medicine_collections USING btree (appointment_id);

CREATE INDEX idx_medcoll_date ON public.medicine_collections USING btree (collected_date);

CREATE INDEX idx_medcoll_patient_date ON public.medicine_collections USING btree (patient_id, collected_date);

CREATE INDEX idx_medications_active ON public.medications USING btree (patient_id, is_active);

CREATE INDEX idx_medications_consultation_id ON public.medications USING btree (consultation_id);

CREATE INDEX idx_medications_group ON public.medications USING btree (patient_id, med_group);

CREATE INDEX idx_medications_parent ON public.medications USING btree (parent_medication_id);

CREATE INDEX idx_medications_patient ON public.medications USING btree (patient_id);

CREATE INDEX idx_medications_patient_active ON public.medications USING btree (patient_id, is_active);

CREATE INDEX idx_medications_patient_visit_status ON public.medications USING btree (patient_id, visit_status) WHERE (is_active = true);

CREATE INDEX idx_medicine_collections_patient_date ON public.medicine_collections USING btree (patient_id, collected_date);

CREATE INDEX idx_meds_action ON public.medications USING btree (action);

CREATE INDEX idx_meds_category ON public.medications USING btree (category);

CREATE INDEX idx_meds_drug_class ON public.medications USING btree (drug_class);

CREATE INDEX idx_meds_for_diagnosis ON public.medications USING btree (for_diagnosis);

CREATE INDEX idx_mhg_protocols_a1c ON public.mhg_clinical_protocols USING btree (a1c_min, a1c_max);

CREATE INDEX idx_mhg_protocols_category ON public.mhg_clinical_protocols USING btree (category);

CREATE INDEX idx_mhg_protocols_egfr ON public.mhg_clinical_protocols USING btree (egfr_min, egfr_max);

CREATE INDEX idx_mhg_protocols_phenotype ON public.mhg_clinical_protocols USING btree (phenotype);

CREATE INDEX idx_mhg_protocols_priority ON public.mhg_clinical_protocols USING btree (priority);

CREATE INDEX idx_mhg_protocols_review ON public.mhg_clinical_protocols USING btree (requires_review);

CREATE INDEX idx_mhg_protocols_type ON public.mhg_clinical_protocols USING btree (protocol_type);

CREATE INDEX idx_obt_appt_date ON public.obt_call_status USING btree (appointment_date);

CREATE INDEX idx_obt_call_date ON public.obt_call_status USING btree (call_date);

CREATE UNIQUE INDEX idx_pal_genie ON public.patient_activity_log USING btree (genie_id);

CREATE UNIQUE INDEX idx_patient_activity_log_genie ON public.patient_activity_log USING btree (patient_id, genie_id);

CREATE INDEX idx_patient_block_log_patient ON public.patient_block_log USING btree (patient_id, created_at DESC);

CREATE INDEX idx_patient_insights_patient ON public.patient_insights USING btree (patient_id, is_active, confidence DESC);

CREATE UNIQUE INDEX idx_patient_meal_log_genie ON public.patient_meal_log USING btree (patient_id, genie_id);

CREATE UNIQUE INDEX idx_patient_med_log_genie ON public.patient_med_log USING btree (patient_id, genie_id);

CREATE INDEX idx_patient_messages_conversation ON public.patient_messages USING btree (conversation_id, created_at);

CREATE INDEX idx_patient_messages_type ON public.patient_messages USING btree (conversation_id, message_type);

CREATE INDEX idx_patient_push_tokens_patient ON public.patient_push_tokens USING btree (patient_id);

CREATE INDEX idx_patient_schemes_active ON public.patient_schemes USING btree (sort_order) WHERE is_active;

CREATE INDEX idx_patient_summaries_patient ON public.patient_summaries USING btree (patient_id, version DESC);

CREATE UNIQUE INDEX idx_patient_symptom_log_genie ON public.patient_symptom_log USING btree (patient_id, genie_id);

CREATE UNIQUE INDEX idx_patient_vitals_log_genie ON public.patient_vitals_log USING btree (patient_id, genie_id);

CREATE UNIQUE INDEX idx_patients_abha ON public.patients USING btree (abha_id) WHERE (abha_id IS NOT NULL);

CREATE INDEX idx_patients_alt_phone ON public.patients USING gin (alt_phone);

CREATE INDEX idx_patients_blocked ON public.patients USING btree (id) WHERE (is_blocked = true);

CREATE UNIQUE INDEX idx_patients_file ON public.patients USING btree (file_no) WHERE (file_no IS NOT NULL);

CREATE INDEX idx_patients_health_id ON public.patients USING btree (health_id);

CREATE UNIQUE INDEX idx_patients_health_id_uniq ON public.patients USING btree (health_id) WHERE (health_id IS NOT NULL);

CREATE INDEX idx_patients_name ON public.patients USING btree (name);

CREATE INDEX idx_patients_phone ON public.patients USING btree (phone) WHERE (phone IS NOT NULL);

CREATE INDEX idx_patients_phone10 ON public.patients USING btree ("right"(regexp_replace((phone)::text, '\D'::text, ''::text, 'g'::text), 10)) WHERE ((phone IS NOT NULL) AND ((phone)::text <> ''::text));

CREATE INDEX idx_patients_scheme ON public.patients USING btree (scheme_code) WHERE (scheme_code IS NOT NULL);

CREATE INDEX idx_pharmacy_inventory_class ON public.pharmacy_inventory USING btree (drug_class);

CREATE UNIQUE INDEX idx_pmeal_genie ON public.patient_meal_log USING btree (genie_id);

CREATE UNIQUE INDEX idx_pml_genie ON public.patient_med_log USING btree (genie_id);

CREATE INDEX idx_prse_patient ON public.patient_reported_side_effects USING btree (patient_id, reported_at DESC);

CREATE INDEX idx_prse_patient_med ON public.patient_reported_side_effects USING btree (patient_id, medication_id);

CREATE UNIQUE INDEX idx_prse_unique_per_med_name ON public.patient_reported_side_effects USING btree (patient_id, COALESCE(medication_id, ''::text), lower(name));

CREATE UNIQUE INDEX idx_psl_genie ON public.patient_symptom_log USING btree (genie_id);

CREATE UNIQUE INDEX idx_pvl_genie ON public.patient_vitals_log USING btree (genie_id);

CREATE INDEX idx_reassign_appt ON public.appointment_reassignments USING btree (appointment_id);

CREATE INDEX idx_reassign_date ON public.appointment_reassignments USING btree (appointment_date);

CREATE INDEX idx_refill_items_request ON public.medication_refill_request_items USING btree (request_id);

CREATE INDEX idx_refill_requests_patient ON public.medication_refill_requests USING btree (patient_id, status, requested_at DESC);

CREATE INDEX idx_refill_requests_status ON public.medication_refill_requests USING btree (status, requested_at DESC);

CREATE INDEX idx_refresh_tokens_expires ON public.refresh_tokens USING btree (expires_at);

CREATE INDEX idx_refresh_tokens_family ON public.refresh_tokens USING btree (family_id);

CREATE INDEX idx_refresh_tokens_hash ON public.refresh_tokens USING btree (token_hash);

CREATE INDEX idx_rxf_agreement ON public.rx_review_feedback USING btree (agreement_level);

CREATE INDEX idx_rxf_condition ON public.rx_review_feedback USING btree (primary_condition);

CREATE INDEX idx_rxf_consultation ON public.rx_review_feedback USING btree (consultation_id);

CREATE INDEX idx_rxf_created ON public.rx_review_feedback USING btree (created_at);

CREATE INDEX idx_rxf_doctor ON public.rx_review_feedback USING btree (doctor_id);

CREATE INDEX idx_rxf_severity ON public.rx_review_feedback USING btree (severity);

CREATE INDEX idx_scheme_cap_overrides_lookup ON public.scheme_cap_overrides USING btree (scheme_code, appointment_date DESC);

CREATE UNIQUE INDEX idx_scheme_opd_fees_default ON public.scheme_opd_fees USING btree (scheme_code, visit_type) WHERE (doctor_id IS NULL);

CREATE UNIQUE INDEX idx_scheme_opd_fees_doctor ON public.scheme_opd_fees USING btree (scheme_code, visit_type, doctor_id) WHERE (doctor_id IS NOT NULL);

CREATE INDEX idx_sessions_token ON public.auth_sessions USING btree (token);

CREATE UNIQUE INDEX idx_side_effects_dedup ON public.patient_reported_side_effects USING btree (patient_id, name, reported_at);

CREATE INDEX idx_slots_date_doctor ON public.appointment_slots USING btree (slot_date, doctor_name);

CREATE INDEX idx_station_appt ON public.station_tracking USING btree (appointment_id);

CREATE INDEX idx_station_date ON public.station_tracking USING btree (visit_date);

CREATE INDEX idx_te_drug ON public.treatment_events USING btree (drug_added);

CREATE INDEX idx_te_override ON public.treatment_events USING btree (doctor_override);

CREATE INDEX idx_te_patient ON public.treatment_events USING btree (patient_id);

CREATE INDEX idx_te_phenotype ON public.treatment_events USING btree (phenotype);

CREATE INDEX idx_te_protocol ON public.treatment_events USING btree (protocol_id);

CREATE INDEX idx_unavail_dates ON public.doctor_unavailability USING btree (start_date, end_date) WHERE (status = 'active'::text);

CREATE INDEX idx_unavail_doctor_dates ON public.doctor_unavailability USING btree (doctor_id, start_date, end_date) WHERE (status = 'active'::text);

CREATE INDEX idx_vitals_patient ON public.vitals USING btree (patient_id);

CREATE INDEX idx_walkin_date ON public.walkin_bookings USING btree (walkin_date);

CREATE UNIQUE INDEX medications_patient_active_name_uniq ON public.medications USING btree (patient_id, upper(COALESCE(pharmacy_match, name))) WHERE (is_active = true);

CREATE UNIQUE INDEX medications_patient_inactive_name_uniq ON public.medications USING btree (patient_id, upper(COALESCE(pharmacy_match, name))) WHERE (is_active = false);

CREATE INDEX patient_messages_patient_idx ON public.patient_messages USING btree (patient_id);

CREATE INDEX patient_messages_unread_idx ON public.patient_messages USING btree (is_read) WHERE (is_read = false);

CREATE UNIQUE INDEX uniq_appt_lead_per_patient ON public.appointments USING btree (patient_id) WHERE (appointment_date IS NULL);

CREATE UNIQUE INDEX uq_diagnoses_patient_dx ON public.diagnoses USING btree (patient_id, diagnosis_id);

CREATE UNIQUE INDEX uq_documents_giniflow_lab_order_id ON public.documents USING btree (giniflow_lab_order_id) WHERE (giniflow_lab_order_id IS NOT NULL);

CREATE UNIQUE INDEX uq_flow_visits_appointment_active ON public.flow_visits USING btree (appointment_id) WHERE ((appointment_id IS NOT NULL) AND (status = ANY (ARRAY['in_progress'::text, 'waiting'::text, 'paused'::text, 'completed'::text])));

CREATE UNIQUE INDEX uq_flow_visits_patient_active_day ON public.flow_visits USING btree (patient_id, visit_date) WHERE (status = ANY (ARRAY['in_progress'::text, 'waiting'::text, 'paused'::text, 'completed'::text]));

CREATE UNIQUE INDEX uq_giniflow_visits_appointment ON public.giniflow_visits USING btree (appointment_id) WHERE (appointment_id IS NOT NULL);

CREATE UNIQUE INDEX uq_meal_logs_source ON public.meal_logs USING btree (source, source_id) WHERE (source_id IS NOT NULL);

CREATE UNIQUE INDEX uq_vitals_giniflow_vitals_id ON public.vitals USING btree (giniflow_vitals_id) WHERE (giniflow_vitals_id IS NOT NULL);

CREATE TRIGGER trg_agent_conversations_updated BEFORE UPDATE ON public.agent_conversations FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

CREATE TRIGGER trg_appt_notify_insert AFTER INSERT ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.notify_appt_inserted();

CREATE TRIGGER trg_consultations_updated BEFORE UPDATE ON public.consultations FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

CREATE TRIGGER trg_diagnoses_updated BEFORE UPDATE ON public.diagnoses FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

CREATE TRIGGER trg_goals_updated BEFORE UPDATE ON public.goals FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

CREATE TRIGGER trg_patient_messages_update_conversation AFTER INSERT ON public.patient_messages FOR EACH ROW EXECUTE FUNCTION public.patient_messages_update_conversation();

CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

ALTER TABLE ONLY public.active_visits
    ADD CONSTRAINT active_visits_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.active_visits
    ADD CONSTRAINT active_visits_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.active_visits
    ADD CONSTRAINT active_visits_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.analytics_snapshot_sections
    ADD CONSTRAINT analytics_snapshot_sections_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.analytics_snapshots(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.app_install_tracking
    ADD CONSTRAINT app_install_tracking_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.appointment_cancellations
    ADD CONSTRAINT appointment_cancellations_original_appointment_id_fkey FOREIGN KEY (original_appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.appointment_change_log
    ADD CONSTRAINT appointment_change_log_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.appointment_reassignments
    ADD CONSTRAINT appointment_reassignments_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.appointment_reassignments
    ADD CONSTRAINT appointment_reassignments_from_doctor_id_fkey FOREIGN KEY (from_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.appointment_reassignments
    ADD CONSTRAINT appointment_reassignments_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.appointment_reassignments
    ADD CONSTRAINT appointment_reassignments_to_doctor_id_fkey FOREIGN KEY (to_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.appointment_reassignments
    ADD CONSTRAINT appointment_reassignments_unavailability_id_fkey FOREIGN KEY (unavailability_id) REFERENCES public.doctor_unavailability(id);

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_corporate_company_id_fkey FOREIGN KEY (corporate_company_id) REFERENCES public.corporate_companies(id);

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_corporate_package_id_fkey FOREIGN KEY (corporate_package_id) REFERENCES public.corporate_packages(id);

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.call_attempts
    ADD CONSTRAINT call_attempts_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.call_attempts
    ADD CONSTRAINT call_attempts_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.call_claim_sessions
    ADD CONSTRAINT call_claim_sessions_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.call_claim_sessions
    ADD CONSTRAINT call_claim_sessions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.care_circle
    ADD CONSTRAINT care_circle_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cc_calling_log
    ADD CONSTRAINT cc_calling_log_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.clinical_reasoning
    ADD CONSTRAINT clinical_reasoning_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.clinical_reasoning
    ADD CONSTRAINT clinical_reasoning_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.clinical_reasoning
    ADD CONSTRAINT clinical_reasoning_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.complications
    ADD CONSTRAINT complications_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.complications
    ADD CONSTRAINT complications_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.consultations
    ADD CONSTRAINT consultations_con_doctor_id_fkey FOREIGN KEY (con_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.consultations
    ADD CONSTRAINT consultations_mo_doctor_id_fkey FOREIGN KEY (mo_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.consultations
    ADD CONSTRAINT consultations_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.corporate_package_tests
    ADD CONSTRAINT corporate_package_tests_package_id_fkey FOREIGN KEY (package_id) REFERENCES public.corporate_packages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.corporate_packages
    ADD CONSTRAINT corporate_packages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.corporate_companies(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.diabetes_champions
    ADD CONSTRAINT diabetes_champions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.diagnoses
    ADD CONSTRAINT diagnoses_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.diagnoses
    ADD CONSTRAINT diagnoses_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.diet_plans
    ADD CONSTRAINT diet_plans_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.diet_plans
    ADD CONSTRAINT diet_plans_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.doctor_profile
    ADD CONSTRAINT doctor_profile_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doctor_unavailability
    ADD CONSTRAINT doctor_unavailability_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.flow_events
    ADD CONSTRAINT flow_events_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.flow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.flow_step_catalog
    ADD CONSTRAINT flow_step_catalog_parent_step_catalog_id_fkey FOREIGN KEY (parent_step_catalog_id) REFERENCES public.flow_step_catalog(id);

ALTER TABLE ONLY public.flow_step_templates
    ADD CONSTRAINT flow_step_templates_step_catalog_id_fkey FOREIGN KEY (step_catalog_id) REFERENCES public.flow_step_catalog(id);

ALTER TABLE ONLY public.flow_step_templates
    ADD CONSTRAINT flow_step_templates_visit_type_id_fkey FOREIGN KEY (visit_type_id) REFERENCES public.flow_visit_types(id);

ALTER TABLE ONLY public.flow_visit_steps
    ADD CONSTRAINT flow_visit_steps_step_catalog_id_fkey FOREIGN KEY (step_catalog_id) REFERENCES public.flow_step_catalog(id);

ALTER TABLE ONLY public.flow_visit_steps
    ADD CONSTRAINT flow_visit_steps_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.flow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_assigned_chief_fkey FOREIGN KEY (assigned_chief) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_assigned_sd_fkey FOREIGN KEY (assigned_sd) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_patient_db_id_fkey FOREIGN KEY (patient_db_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.flow_visits
    ADD CONSTRAINT flow_visits_visit_type_id_fkey FOREIGN KEY (visit_type_id) REFERENCES public.flow_visit_types(id);

ALTER TABLE ONLY public.giniflow_care_plans
    ADD CONSTRAINT giniflow_care_plans_authored_by_fkey FOREIGN KEY (authored_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_care_plans
    ADD CONSTRAINT giniflow_care_plans_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_floor_settings
    ADD CONSTRAINT giniflow_floor_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_interaction_acks
    ADD CONSTRAINT giniflow_interaction_acks_acked_by_fkey FOREIGN KEY (acked_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_interaction_acks
    ADD CONSTRAINT giniflow_interaction_acks_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_lab_case_actions
    ADD CONSTRAINT giniflow_lab_case_actions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_lab_order_events
    ADD CONSTRAINT giniflow_lab_order_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_lab_order_events
    ADD CONSTRAINT giniflow_lab_order_events_lab_order_id_fkey FOREIGN KEY (lab_order_id) REFERENCES public.giniflow_lab_orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_lab_order_tests
    ADD CONSTRAINT giniflow_lab_order_tests_lab_order_id_fkey FOREIGN KEY (lab_order_id) REFERENCES public.giniflow_lab_orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_lab_orders
    ADD CONSTRAINT giniflow_lab_orders_claim_approved_by_fkey FOREIGN KEY (claim_approved_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_lab_orders
    ADD CONSTRAINT giniflow_lab_orders_ordered_by_fkey FOREIGN KEY (ordered_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_lab_orders
    ADD CONSTRAINT giniflow_lab_orders_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_patient_bills
    ADD CONSTRAINT giniflow_patient_bills_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_referrals
    ADD CONSTRAINT giniflow_referrals_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_referrals
    ADD CONSTRAINT giniflow_referrals_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.giniflow_referrals
    ADD CONSTRAINT giniflow_referrals_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_rx_items
    ADD CONSTRAINT giniflow_rx_items_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_rx_items
    ADD CONSTRAINT giniflow_rx_items_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_rx_items
    ADD CONSTRAINT giniflow_rx_items_source_medication_id_fkey FOREIGN KEY (source_medication_id) REFERENCES public.medications(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.giniflow_rx_items
    ADD CONSTRAINT giniflow_rx_items_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_rx_proposals
    ADD CONSTRAINT giniflow_rx_proposals_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_rx_proposals
    ADD CONSTRAINT giniflow_rx_proposals_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_rx_proposals
    ADD CONSTRAINT giniflow_rx_proposals_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_sd_notes
    ADD CONSTRAINT giniflow_sd_notes_authored_by_fkey FOREIGN KEY (authored_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_sd_notes
    ADD CONSTRAINT giniflow_sd_notes_reports_reviewed_by_fkey FOREIGN KEY (reports_reviewed_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_sd_notes
    ADD CONSTRAINT giniflow_sd_notes_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_triage_events
    ADD CONSTRAINT giniflow_triage_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_triage_events
    ADD CONSTRAINT giniflow_triage_events_assigned_doctor_id_fkey FOREIGN KEY (assigned_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_triage_events
    ADD CONSTRAINT giniflow_triage_events_assigned_sd_id_fkey FOREIGN KEY (assigned_sd_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_triage_events
    ADD CONSTRAINT giniflow_triage_events_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_visit_events
    ADD CONSTRAINT giniflow_visit_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visit_events
    ADD CONSTRAINT giniflow_visit_events_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_visit_steps
    ADD CONSTRAINT giniflow_visit_steps_step_catalog_id_fkey FOREIGN KEY (step_catalog_id) REFERENCES public.flow_step_catalog(id);

ALTER TABLE ONLY public.giniflow_visit_steps
    ADD CONSTRAINT giniflow_visit_steps_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_assigned_doctor_id_fkey FOREIGN KEY (assigned_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_assigned_sd_id_fkey FOREIGN KEY (assigned_sd_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_category_set_by_fkey FOREIGN KEY (category_set_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_checked_in_by_fkey FOREIGN KEY (checked_in_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_merged_into_visit_id_fkey FOREIGN KEY (merged_into_visit_id) REFERENCES public.giniflow_visits(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_paused_by_fkey FOREIGN KEY (paused_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_priority_set_by_fkey FOREIGN KEY (priority_set_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_visits
    ADD CONSTRAINT giniflow_visits_visit_type_id_fkey FOREIGN KEY (visit_type_id) REFERENCES public.flow_visit_types(id);

ALTER TABLE ONLY public.giniflow_vitals
    ADD CONSTRAINT giniflow_vitals_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.giniflow_vitals
    ADD CONSTRAINT giniflow_vitals_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.giniflow_vitals
    ADD CONSTRAINT giniflow_vitals_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES public.giniflow_visits(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.lab_cases
    ADD CONSTRAINT lab_cases_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.lab_cases
    ADD CONSTRAINT lab_cases_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.lab_report_tests
    ADD CONSTRAINT lab_report_tests_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.lab_report_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lab_report_tests
    ADD CONSTRAINT lab_report_tests_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.lab_test_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_lab_order_id_fkey FOREIGN KEY (lab_order_id) REFERENCES public.giniflow_lab_orders(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.lab_test_catalog
    ADD CONSTRAINT lab_test_catalog_parent_test_id_fkey FOREIGN KEY (parent_test_id) REFERENCES public.lab_test_catalog(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.lab_test_ranges
    ADD CONSTRAINT lab_test_ranges_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.lab_test_catalog(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lab_test_requests
    ADD CONSTRAINT lab_test_requests_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.lead_events
    ADD CONSTRAINT lead_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.lead_campaigns(id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_merged_into_id_fkey FOREIGN KEY (merged_into_id) REFERENCES public.leads(id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_owner_doctor_id_fkey FOREIGN KEY (owner_doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.meal_logs
    ADD CONSTRAINT meal_logs_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.medication_adherence
    ADD CONSTRAINT medication_adherence_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.medication_dose_change_requests
    ADD CONSTRAINT medication_dose_change_requests_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.medication_refill_request_items
    ADD CONSTRAINT medication_refill_request_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.medication_refill_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.medication_refill_requests
    ADD CONSTRAINT medication_refill_requests_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.medications
    ADD CONSTRAINT medications_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.medications
    ADD CONSTRAINT medications_drug_master_id_fkey FOREIGN KEY (drug_master_id) REFERENCES public.drug_master(id);

ALTER TABLE ONLY public.medications
    ADD CONSTRAINT medications_parent_medication_id_fkey FOREIGN KEY (parent_medication_id) REFERENCES public.medications(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.medications
    ADD CONSTRAINT medications_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.medicine_collections
    ADD CONSTRAINT medicine_collections_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.medicine_collections
    ADD CONSTRAINT medicine_collections_medication_id_fkey FOREIGN KEY (medication_id) REFERENCES public.medications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.medicine_collections
    ADD CONSTRAINT medicine_collections_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.obt_call_status
    ADD CONSTRAINT obt_call_status_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);

ALTER TABLE ONLY public.patient_activity_log
    ADD CONSTRAINT patient_activity_log_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_block_log
    ADD CONSTRAINT patient_block_log_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_conditions_genie
    ADD CONSTRAINT patient_conditions_genie_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_documents
    ADD CONSTRAINT patient_documents_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.patient_drug_history
    ADD CONSTRAINT patient_drug_history_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_insights
    ADD CONSTRAINT patient_insights_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.patient_meal_log
    ADD CONSTRAINT patient_meal_log_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_med_log
    ADD CONSTRAINT patient_med_log_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_medications_genie
    ADD CONSTRAINT patient_medications_genie_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_messages
    ADD CONSTRAINT patient_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.patient_messages
    ADD CONSTRAINT patient_messages_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_push_tokens
    ADD CONSTRAINT patient_push_tokens_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.patient_reported_side_effects
    ADD CONSTRAINT patient_reported_side_effects_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.patient_special_alerts
    ADD CONSTRAINT patient_special_alerts_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patient_symptom_log
    ADD CONSTRAINT patient_symptom_log_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_allergy_asked_by_fkey FOREIGN KEY (allergy_asked_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_scheme_code_fkey FOREIGN KEY (scheme_code) REFERENCES public.patient_schemes(code);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.rx_review_feedback
    ADD CONSTRAINT rx_review_feedback_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.rx_review_feedback
    ADD CONSTRAINT rx_review_feedback_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.rx_review_feedback
    ADD CONSTRAINT rx_review_feedback_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.scheme_cap_overrides
    ADD CONSTRAINT scheme_cap_overrides_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.scheme_cap_overrides
    ADD CONSTRAINT scheme_cap_overrides_overridden_by_fkey FOREIGN KEY (overridden_by) REFERENCES public.doctors(id);

ALTER TABLE ONLY public.scheme_medicine_prices
    ADD CONSTRAINT scheme_medicine_prices_scheme_code_fkey FOREIGN KEY (scheme_code) REFERENCES public.patient_schemes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.scheme_opd_fees
    ADD CONSTRAINT scheme_opd_fees_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scheme_opd_fees
    ADD CONSTRAINT scheme_opd_fees_scheme_code_fkey FOREIGN KEY (scheme_code) REFERENCES public.patient_schemes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.scheme_test_prices
    ADD CONSTRAINT scheme_test_prices_scheme_code_fkey FOREIGN KEY (scheme_code) REFERENCES public.patient_schemes(code) ON DELETE CASCADE;

ALTER TABLE ONLY public.station_tracking
    ADD CONSTRAINT station_tracking_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.station_tracking
    ADD CONSTRAINT station_tracking_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.symptom_logs
    ADD CONSTRAINT symptom_logs_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.treatment_events
    ADD CONSTRAINT treatment_events_protocol_id_fkey FOREIGN KEY (protocol_id) REFERENCES public.mhg_clinical_protocols(protocol_id);

ALTER TABLE ONLY public.visit_readiness
    ADD CONSTRAINT visit_readiness_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.visit_symptoms
    ADD CONSTRAINT visit_symptoms_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE ONLY public.vitals
    ADD CONSTRAINT vitals_consultation_id_fkey FOREIGN KEY (consultation_id) REFERENCES public.consultations(id);

ALTER TABLE ONLY public.vitals
    ADD CONSTRAINT vitals_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patients(id);

ALTER TABLE public.active_visits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ai_batch_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alert_channel ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_snapshot_sections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.app_install_tracking ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.app_kv ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.appointment_cancellations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.appointment_change_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.appointment_reassignments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.appointment_slots ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.call_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.care_circle ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cc_agents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cc_calling_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.clinic_holidays ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.clinical_reasoning ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.complications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.consultation_test_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.consultations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.corporate_companies ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.corporate_package_tests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.corporate_packages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.diabetes_champions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.diagnoses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.diet_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_profile ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_summaries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_unavailability ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctors ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.drug_master ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_staff ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_step_catalog ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_step_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_visit_steps ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_visit_types ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_visits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_wait_daily ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_wait_station_daily ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_care_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_interaction_acks ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_interaction_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_lab_case_actions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_lab_order_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_lab_order_tests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_lab_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_patient_bills ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_referrals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_rx_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_rx_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_sd_notes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_sla_config ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_test_catalog ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_test_panels ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_triage_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_visit_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_visit_steps ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_visits ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.giniflow_vitals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.glp1_cohort ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.l3_a1c_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.l3_drug_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.l3_ldl_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.l3_uacr_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.l3_weight_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lab_cases ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lab_results ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lab_results_appt_unlink_backup_20260430 ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lab_test_mapping ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lab_test_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.layer3_outcomes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lead_campaigns ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.meal_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.medication_adherence ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.medication_dose_change_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.medication_refill_request_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.medication_refill_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.medications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.medicine_collections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mhg_clinical_protocols ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mhg_drug_formulary ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mhg_vitals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.obt_call_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_activity_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_block_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_briefs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_conditions_genie ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_drug_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_health_model ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_insights ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_meal_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_med_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_med_streak ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_medications_genie ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_metabolic_profile ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_phenotype ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_push_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_reported_side_effects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_special_alerts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_summaries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_symptom_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_treatment_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_vitals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patient_vitals_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pharmacy_inventory ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rx_review_feedback ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.slot_catalog ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.station_tracking ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.symptom_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.treatment_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.treatment_gaps ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.visit_readiness ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.visit_symptoms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vitals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.walkin_bookings ENABLE ROW LEVEL SECURITY;

