SET NAMES utf8mb4;
CREATE TABLE native_small (id BIGINT PRIMARY KEY, amount DECIMAL(28,8), label VARCHAR(100), optional_value DOUBLE);
INSERT INTO native_small VALUES
 (9007199254740993,123456789.12345678,'中文',NULL),
 (2,-0.00000001,'second',2.5),
 (3,NULL,NULL,-3.25);
CREATE TABLE native_large (id INTEGER PRIMARY KEY, value DOUBLE);
CREATE TABLE fixture_digits (n INTEGER);
INSERT INTO fixture_digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);
INSERT INTO native_large
 SELECT 1+a.n+10*b.n+100*c.n+1000*d.n,(1+a.n+10*b.n+100*c.n+1000*d.n)*0.5
 FROM fixture_digits a CROSS JOIN fixture_digits b CROSS JOIN fixture_digits c CROSS JOIN fixture_digits d;
DROP TABLE fixture_digits;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'stats_reader'@'%';
GRANT SELECT ON statsplayground_test.* TO 'stats_reader'@'%';
