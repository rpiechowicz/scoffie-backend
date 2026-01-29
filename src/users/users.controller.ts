import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOkResponse({
    schema: {
      example: {
        user: {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          googleId: '1234567890',
          displayName: 'Anna Nowak',
          email: 'anna@example.com',
          avatarUrl: 'https://i.pravatar.cc/150?img=47',
          createdAt: '2026-01-29T17:00:00.000Z',
          updatedAt: '2026-01-29T17:00:00.000Z',
        },
        households: [
          {
            id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            name: 'Home',
            role: 'OWNER',
          },
        ],
      },
    },
  })
  async me(@Req() req: any) {
    const user = await this.usersService.getMe(req.user.id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      user,
      households: user.memberships.map((m) => ({
        id: m.household.id,
        name: m.household.name,
        role: m.role,
      })),
    };
  }

  @Get()
  @ApiOkResponse({ type: [UserDto] })
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @ApiOkResponse({ type: UserDto })
  async findById(@Param('id') id: string) {
    const user = await this.usersService.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  @Post()
  @ApiCreatedResponse({ type: UserDto })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }
}
