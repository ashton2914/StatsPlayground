CREATE ROLE stats_reader LOGIN PASSWORD 'statspg-fixture-reader';

CREATE TABLE cell_a_raw (
    "Rec#" BIGINT NOT NULL,
    "Channel" TEXT NOT NULL,
    "DPT" TIMESTAMP NOT NULL,
    "Test Time" TEXT NOT NULL,
    "Current (A)" NUMERIC(10, 3) NOT NULL,
    "Voltage (V)" NUMERIC(10, 3) NOT NULL
);

INSERT INTO cell_a_raw
SELECT
    sample,
    'Channel ' || channel,
    TIMESTAMP '2026-01-01 00:00:00' + sample * INTERVAL '1 second',
    ':0:' || to_char(TIME '00:00:00' + sample * INTERVAL '1 second', 'HH24:MI:SS'),
    channel * 0.25,
    3.2 + (sample % 100) * 0.005
FROM generate_series(1, 4) AS channel
CROSS JOIN generate_series(1, 2500) AS sample;

GRANT CONNECT ON DATABASE statspg_review TO stats_reader;
GRANT USAGE ON SCHEMA public TO stats_reader;
GRANT SELECT ON cell_a_raw TO stats_reader;
