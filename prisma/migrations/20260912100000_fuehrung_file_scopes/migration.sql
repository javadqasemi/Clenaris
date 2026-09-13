-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileScope" ADD VALUE 'OBJECTIVE';
ALTER TYPE "FileScope" ADD VALUE 'INVESTMENT';
ALTER TYPE "FileScope" ADD VALUE 'RISK';
ALTER TYPE "FileScope" ADD VALUE 'CONTROL';
ALTER TYPE "FileScope" ADD VALUE 'DOCUMENT';
ALTER TYPE "FileScope" ADD VALUE 'ARTICLE';
ALTER TYPE "FileScope" ADD VALUE 'MEETING';
ALTER TYPE "FileScope" ADD VALUE 'REPORT';

