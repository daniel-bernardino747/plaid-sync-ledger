-- Cluster-level roles (ADR 0007). Privileges on tables are granted by migrations.
-- Local-development passwords only.
CREATE ROLE app_web LOGIN PASSWORD 'app_web' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_system LOGIN PASSWORD 'app_system' NOSUPERUSER BYPASSRLS;
-- Migrations run as the owner, which is a superuser here; CREATE DATABASE ... TEMPLATE for chaos needs it.
