CREATE ROLE stats_reader LOGIN PASSWORD 'issue282-test-only-reader';
CREATE TABLE native_small (id BIGINT PRIMARY KEY, amount DECIMAL(28,8), label VARCHAR(100), optional_value DOUBLE PRECISION);
INSERT INTO native_small VALUES
 (9007199254740993,123456789.12345678,'中文',NULL),
 (2,-0.00000001,'second',2.5),
 (3,NULL,NULL,-3.25);
CREATE TABLE native_large AS SELECT value AS id, value * 0.5 AS value FROM generate_series(1,10000) value;
GRANT CONNECT ON DATABASE statsplayground_test TO stats_reader;
GRANT USAGE ON SCHEMA public TO stats_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stats_reader;
