//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_ATOMIC_DETAIL_FENCED_BLOCK_GCC_SYNC_HPP
#define ZI_ATOMIC_DETAIL_FENCED_BLOCK_GCC_SYNC_HPP 1

#ifndef ZI_ATOMIC_FENCED_BLOCK_HPP_INCLUDING
#  error "don't include this file directly, use fenced_block.hpp"
#endif

class fenced_block: non_copyable
{
private:
    int tmp_;

public:
    fenced_block(): tmp_( 0 )
    {
        __sync_lock_test_and_set( &tmp_, 1 );
    }

    ~fenced_block()
    {
        __sync_lock_release( &tmp_ );
    }

};

#endif
