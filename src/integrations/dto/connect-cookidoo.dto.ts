import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class ConnectCookidooDto {
  @ApiProperty({ example: 'rafal@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  // Hasło jest szyfrowane i zapisywane w bazie, a potem wysyłane do
  // mikroserwisu przy każdej wysyłce — górna granica, żeby nikt nie zapisał
  // nam 100 KB „hasła".
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password: string;
}
