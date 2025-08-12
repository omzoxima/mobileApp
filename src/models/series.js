import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const Series = sequelize.define('Series', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT
    },
    releaseYear: {
      type: DataTypes.INTEGER
    },
    thumbnail_url: {
      type: DataTypes.STRING
    },
    carousel_image_url: {
      type: DataTypes.STRING
    },
    category_id: {
      type: DataTypes.UUID,
      references: {
        model: 'categories',
        key: 'id'
      }
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    is_popular: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING)
    },
    status: {
      type: DataTypes.ENUM('Draft', 'Active', 'Inactive'),
      defaultValue: 'Draft'
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'series',
    timestamps: false
  });

  return Series;
};